import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTask, undoApply } from "../src/actions.ts";
import { combineTasks } from "../src/combine.ts";
import { parseConfig } from "../src/config.ts";
import { branchFor, git, snapshot, YXU_IDENTITY } from "../src/git.ts";
import { Session, TaskOps } from "../src/ops.ts";
import { fakeCli, pathWith } from "./helpers.ts";

let root: string;
let bin: string;
const origPath = process.env.PATH;

// Fake `opencode`: "WRITE <file> <word>" writes a file, "DELETE <file>" removes one, "SEE <file>"
// copies a file's content into seen.txt (to check what the agent's copy contains),
// "SWITCH" checks out another branch and commits there (like `git checkout pr-465`).
const FAKE = `#!/bin/sh
for a; do last="$a"; done
printf '%s\\n' "$last" | grep -oE 'WRITE [^ ]+ [^ ]+' | while read _ f c; do mkdir -p "$(dirname "$f")"; printf '%s\\n' "$c" > "$f"; done
printf '%s\\n' "$last" | grep -oE 'DELETE [^ ]+' | while read _ f; do rm -f "$f"; done
printf '%s\\n' "$last" | grep -oE 'SEE [^ ]+' | while read _ f; do cat "$f" > seen.txt 2>/dev/null || echo missing > seen.txt; done
case "$last" in *SWITCH*) git checkout -q -b someone-elses-pr; echo pr > pr.txt; git add pr.txt; git -c user.name=x -c user.email=x@x commit -qm pr;; esac
echo '{"type":"text","sessionID":"s","part":{"type":"text","text":"done"}}'
`;

const cfg = () => parseConfig("agents:\n  coder: { cli: opencode }\ncontext: { repo_map: false }\n", join(root, "yxu.yaml"));
const read = (f: string) => readFileSync(join(root, f), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-apply-"));
  bin = mkdtempSync(join(tmpdir(), "yxu-apply-bin-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  writeFileSync(join(root, "gone.txt"), "to delete\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
  fakeCli(bin, "opencode", FAKE);
  process.env.PATH = pathWith(bin, origPath);
});
afterEach(() => {
  process.env.PATH = origPath;
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("tasks start from your working tree", () => {
  test("agents see uncommitted and untracked changes; the snapshot leaves your index and files alone", async () => {
    writeFileSync(join(root, "b.txt"), "b edited, not committed\n");
    writeFileSync(join(root, "new.txt"), "untracked\n");
    git(root, "add", "b.txt"); // staged, to check the index is untouched
    const statusBefore = git(root, "status", "--porcelain");
    const snap = snapshot(root);
    expect(snap).not.toBe(git(root, "rev-parse", "HEAD"));
    expect(snapshot(root)).toBe(snap); // same tree, same commit
    expect(git(root, "status", "--porcelain")).toBe(statusBefore);

    const ops = new TaskOps(cfg(), root, new Session(), {});
    const r = await ops.delegate("coder", "SEE b.txt");
    expect(git(root, "show", `${branchFor(r.taskId)}:seen.txt`)).toBe("b edited, not committed");
    const r2 = await ops.delegate("coder", "SEE new.txt");
    expect(git(root, "show", `${branchFor(r2.taskId)}:seen.txt`)).toBe("untracked");
  }, 30_000);
});

describe("apply in place", () => {
  test("the task's changes become uncommitted edits next to yours: no commit, no branch switch", async () => {
    writeFileSync(join(root, "b.txt"), "my own edit\n"); // dirty before the task
    const ops = new TaskOps(cfg(), root, new Session(), {});
    const t = await ops.delegate("coder", "WRITE src/new.ts hello WRITE c.txt sea DELETE gone.txt");
    const head = git(root, "rev-parse", "HEAD");
    const r = applyTask(root, t.taskId);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^applied 3 files to your working tree \(\+2 −1\), uncommitted$/);
    expect(git(root, "rev-parse", "HEAD")).toBe(head); // no commit
    expect(git(root, "branch", "--show-current")).toBe("main");
    expect(read("src/new.ts")).toBe("hello\n");
    expect(existsSync(join(root, "gone.txt"))).toBe(false);
    expect(read("b.txt")).toBe("my own edit\n"); // yours untouched
    expect(existsSync(join(root, ".yxu", "worktrees", t.taskId))).toBe(false); // worktree cleaned up
    expect(applyTask(root, t.taskId).ok).toBe(false); // nothing left to apply twice
  }, 30_000);

  test("you edited the same file meanwhile: merged; overlapping lines get conflict markers in that file only", async () => {
    const ops = new TaskOps(cfg(), root, new Session(), {});
    // The fake writes whole files, so build the task's version with a shell step instead
    // (sed -i.bak: the form both GNU and BSD sed accept).
    const t = await ops.shell("edit", "sed -i.bak 's/^two$/TWO by task/; s/^six$/SIX by task/' a.txt && rm a.txt.bak");
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nFOUR by you\nfive\nsix\nseven\n"); // a different line
    let r = applyTask(root, t.task!.taskId);
    expect(r.ok).toBe(true);
    expect(read("a.txt")).toBe("one\nTWO by task\nthree\nFOUR by you\nfive\nSIX by task\nseven\n");

    const t2 = await ops.shell("edit2", "sed -i.bak 's/^seven$/SEVEN by task/' a.txt && rm a.txt.bak");
    writeFileSync(join(root, "a.txt"), read("a.txt").replace("seven", "seven by you")); // the same line
    writeFileSync(join(root, "b.txt"), "b edited\n");
    r = applyTask(root, t2.task!.taskId);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("overlapping edits in a.txt");
    expect(read("a.txt")).toContain("<<<<<<< your working tree");
    expect(read("a.txt")).toContain(`>>>>>>> task ${t2.task!.taskId}`);
    expect(read("b.txt")).toBe("b edited\n");
  }, 30_000);

  test("undo puts back what the apply changed, and leaves files you edited since", async () => {
    writeFileSync(join(root, "b.txt"), "mine\n");
    const ops = new TaskOps(cfg(), root, new Session(), {});
    const t = await ops.delegate("coder", "WRITE c.txt sea WRITE d.txt land DELETE gone.txt");
    applyTask(root, t.taskId);
    writeFileSync(join(root, "d.txt"), "land, then my edit\n");
    const u = undoApply(root);
    expect(u.ok).toBe(true);
    expect(u.message).toBe(`undid task ${t.taskId}: restored 2 files; left d.txt as is (you changed it after the apply)`);
    expect(existsSync(join(root, "c.txt"))).toBe(false);
    expect(read("gone.txt")).toBe("to delete\n");
    expect(read("d.txt")).toBe("land, then my edit\n");
    expect(read("b.txt")).toBe("mine\n");
    expect(undoApply(root).ok).toBe(false); // only once
  }, 30_000);

  test("an agent that switches to another branch doesn't turn that branch into its work", async () => {
    const ops = new TaskOps(cfg(), root, new Session(), {});
    const t = await ops.delegate("coder", "Verification only. SWITCH");
    expect(t.filesChanged).toEqual([]);
    expect(t.branch).toBeUndefined();
    expect(t.summary).toContain("[warning] the agent switched its worktree to someone-elses-pr; that isn't its work, so nothing from it is kept");
  }, 30_000);

  test("parallel tasks combine on the same starting point and apply together", async () => {
    writeFileSync(join(root, "b.txt"), "uncommitted base\n");
    const ops = new TaskOps(cfg(), root, new Session(), {});
    const [x, y] = await Promise.all([ops.delegate("coder", "WRITE x.txt x"), ops.delegate("coder", "WRITE y.txt y")]);
    const c = await combineTasks({ root, taskIds: [x!.taskId, y!.taskId] });
    expect(c.ok).toBe(true);
    expect(c.filesChanged.sort()).toEqual(["x.txt", "y.txt"]); // the uncommitted base isn't counted as a change
    const r = applyTask(root, c.taskId);
    expect(r.ok).toBe(true);
    expect(read("x.txt") + read("y.txt") + read("b.txt")).toBe("x\ny\nuncommitted base\n");
  }, 30_000);
});
