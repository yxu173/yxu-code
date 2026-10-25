import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combineTasks, readTaskRecord, taskAncestors } from "../src/combine.ts";
import { collectChanges, createWorktree, git, YXU_IDENTITY } from "../src/git.ts";
import { newTaskId, Semaphore, writeTaskRecord } from "../src/runner.ts";
import { emptyUsage } from "../src/types.ts";
import { fakeCli, pathWith } from "./helpers.ts";

let root: string;
let bin: string;
const origPath = process.env.PATH;

/** Make a task branch the way runTask would, without running an agent. */
function fakeTask(file: string, content: string, extra: Record<string, unknown> = {}, baseRef?: string) {
  const id = newTaskId();
  const wt = createWorktree(root, id, baseRef);
  writeFileSync(join(wt.path, file), content);
  const { diff, files } = collectChanges(wt, `edit ${file}`);
  writeTaskRecord(
    root,
    {
      ok: true, summary: `edited ${file}`, usage: emptyUsage(), taskId: id, agent: "fake", exitCode: 0,
      durationMs: 1, diff, filesChanged: files, branch: wt.branch, worktree: wt.path,
    },
    { prompt: `edit ${file}`, baseRef, ...extra },
  );
  return id;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-test-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");

  // Fake `opencode` that "resolves" conflicts by dropping marker lines (keeping both sides).
  bin = mkdtempSync(join(tmpdir(), "yxu-bin-"));
  const script = `#!/bin/sh
for f in $(grep -rlE '^(<<<<<<<|=======|>>>>>>>)' --exclude-dir=.git . 2>/dev/null); do
  grep -vE '^(<<<<<<<|=======|>>>>>>>)' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
echo '{"type":"text","sessionID":"ses_fake","part":{"type":"text","text":"resolved"}}'
echo '{"type":"step_finish","sessionID":"ses_fake","part":{"reason":"stop","tokens":{"input":1,"output":1},"cost":0}}'
`;
  fakeCli(bin, "opencode", script);
  process.env.PATH = pathWith(bin, origPath);
});

afterEach(() => {
  process.env.PATH = origPath;
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("combineTasks", () => {
  test("merges independent tasks into one branch", async () => {
    const t1 = fakeTask("a.txt", "line1\nline2 changed\nline3\n");
    const t2 = fakeTask("c.txt", "new file\n");
    const r = await combineTasks({ root, taskIds: [t1, t2] });
    expect(r.ok).toBe(true);
    expect(r.filesChanged.sort()).toEqual(["a.txt", "c.txt"]);
    expect(r.summary).toContain("No conflicts");
    expect(readFileSync(join(r.worktree!, "c.txt"), "utf8")).toBe("new file\n");
    expect(readTaskRecord(root, r.taskId)?.parents).toEqual([t1, t2]);
    // The user's checkout is untouched.
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  test("conflict without resolver fails and cleans up", async () => {
    const t1 = fakeTask("a.txt", "line1\nFROM ONE\nline3\n");
    const t2 = fakeTask("a.txt", "line1\nFROM TWO\nline3\n");
    const r = await combineTasks({ root, taskIds: [t1, t2] });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual(["a.txt"]);
    expect(git(root, "branch", "--list", `yxu/${r.taskId}`)).toBe("");
    expect(git(root, "worktree", "list")).not.toContain(r.taskId);
  });

  test("conflict with resolver agent is resolved and committed", async () => {
    const t1 = fakeTask("a.txt", "line1\nFROM ONE\nline3\n");
    const t2 = fakeTask("a.txt", "line1\nFROM TWO\nline3\n");
    const r = await combineTasks({
      root,
      taskIds: [t1, t2],
      resolver: { name: "fixer", profile: { cli: "opencode" } },
    });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("fixer resolved conflicts in a.txt");
    const merged = readFileSync(join(r.worktree!, "a.txt"), "utf8");
    expect(merged).toContain("FROM ONE");
    expect(merged).toContain("FROM TWO");
    expect(merged).not.toContain("<<<<<<<");
    expect(git(r.worktree!, "status", "--porcelain")).toBe("");
  });

  test("rejects tasks without changes", async () => {
    const t1 = fakeTask("a.txt", "x\n");
    await expect(combineTasks({ root, taskIds: [t1, "nope"] })).rejects.toThrow(/unknown task/);
  });
});

describe("taskAncestors", () => {
  test("follows build_on chains and combine parents", async () => {
    const t1 = fakeTask("a.txt", "one\n");
    const t2 = fakeTask("a.txt", "two\n", {}, `yxu/${t1}`);
    const t3 = fakeTask("b.txt", "three\n");
    const c = await combineTasks({ root, taskIds: [t2, t3] });
    expect(c.ok).toBe(true);
    expect(taskAncestors(root, c.taskId).sort()).toEqual([t1, t2, t3].sort());
    expect(taskAncestors(root, t2)).toEqual([t1]);
  });
});

describe("Semaphore", () => {
  test("limits concurrency", async () => {
    const sem = new Semaphore(2);
    let live = 0;
    let peak = 0;
    const job = () =>
      sem.run(async () => {
        live++;
        peak = Math.max(peak, live);
        await Bun.sleep(10);
        live--;
      });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
  });

  test("releases on error", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await sem.run(async () => 42)).toBe(42);
  });
});
