import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWithHooks } from "../src/actions.ts";
import { parseConfig, type Config } from "../src/config.ts";
import { branchFor, git, YXU_IDENTITY } from "../src/git.ts";
import { runHooks, withRunHooks } from "../src/hooks.ts";
import { Session, TaskOps } from "../src/ops.ts";
import type { RunOutcome } from "../src/orchestrator/run.ts";
import { fakeCli, pathWith } from "./helpers.ts";

let root: string;
let bin: string;
let out: string;
const origPath = process.env.PATH;

const FAKE_AGENT = `#!/bin/sh
for a; do last="$a"; done
printf '%s\\n' "$last" | grep -oE 'WRITE [^ ]+ [^ ]+' | while read _ f c; do printf '%s\\n' "$c" > "$f"; done
echo '{"type":"text","sessionID":"s","part":{"type":"text","text":"done"}}'
echo '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{"input":1,"output":1},"cost":0}}'
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-hooks-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README"), "x\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
  bin = mkdtempSync(join(tmpdir(), "yxu-bin-"));
  out = mkdtempSync(join(tmpdir(), "yxu-out-")).replaceAll("\\", "/"); // also inside YAML strings on Windows
  fakeCli(bin, "opencode", FAKE_AGENT);
  process.env.PATH = pathWith(bin, origPath);
});
afterEach(() => {
  process.env.PATH = origPath;
  for (const d of [root, bin, out]) rmSync(d, { recursive: true, force: true });
});

const cfg = (hooks: string): Config => parseConfig(`agents:\n  coder: { cli: opencode }\nhooks:\n${hooks}`, "test");

describe("hooks", () => {
  test("commands get the event as JSON on stdin and shell-quoted placeholders", async () => {
    const c = cfg(`  on_complete: ["cat > ${out}/payload.json", "printf '%s|' {{tasks.0.files}} > ${out}/args"]\n`);
    const h = await runHooks(c, "on_complete", { goal: "g", tasks: [{ files: ["a b.txt", "c.txt"] }] }, { cwd: root });
    expect(h.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "payload.json"), "utf8"))).toMatchObject({ event: "on_complete", goal: "g" });
    expect(readFileSync(join(out, "args"), "utf8")).toBe("a b.txt|c.txt|");
  });

  test("after_task runs in the task's worktree and its changes join the task", async () => {
    const c = cfg(`  after_task: ["printf '%s\\\\n' {{task.files}} > touched.txt", "exit 4"]\n`);
    const ops = new TaskOps(c, root, new Session());
    const r = await ops.delegate("coder", "WRITE a.txt alpha");
    expect(r.filesChanged.sort()).toEqual(["a.txt", "touched.txt"]);
    expect(git(root, "show", `${branchFor(r.taskId)}:touched.txt`)).toBe("a.txt");
    expect(r.diff).toContain("touched.txt");
    expect(r.summary).toContain("[warning] after_task hook `exit 4` failed (exit 4)");
    const rec = JSON.parse(readFileSync(join(root, ".yxu", "runs", r.taskId, "result.json"), "utf8"));
    expect(rec.filesChanged.sort()).toEqual(["a.txt", "touched.txt"]);
    expect(rec.prompt).toContain("WRITE a.txt"); // the original record is kept
    expect(existsSync(join(root, "touched.txt"))).toBe(false); // the checkout is untouched
  });

  test("before_apply blocks a failing task and lets a passing one through", async () => {
    const ops = new TaskOps(cfg("  after_task: []\n"), root, new Session());
    const r = await ops.delegate("coder", "WRITE a.txt alpha");
    const blocked = await applyWithHooks(cfg(`  before_apply: ["test -f a.txt", "echo tests failed; exit 1"]\n`), root, r.taskId);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/before_apply hook `echo tests failed; exit 1` failed \(exit 1\):\ntests failed\nNothing was applied/);
    expect(existsSync(join(root, "a.txt"))).toBe(false);
    const applied = await applyWithHooks(cfg(`  before_apply: ["test -f a.txt"]\n`), root, r.taskId);
    expect(applied.ok).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha\n");
  });

  test("before_run can block a run; on_failure / on_complete see the outcome", async () => {
    const session = new Session();
    const outcome = (ok: boolean): RunOutcome => ({ runId: "r", ok, finalText: "done", costUsd: 0.5, session });
    let ran = 0;
    const run = (ok: boolean) => async () => (ran++, outcome(ok));

    const blocked = await withRunHooks(cfg(`  before_run: ["echo dirty tree; exit 2"]\n`), root, { goal: "g", workflow: "w", session }, run(true));
    expect(blocked.ok).toBe(false);
    expect(blocked.finalText).toContain("Run blocked: before_run hook");
    expect(ran).toBe(0);

    const c = cfg(`  on_complete: ["cat > ${out}/done.json"]\n  on_failure: ["cat > ${out}/failed.json", "exit 9"]\n`);
    await withRunHooks(c, root, { goal: "g", workflow: "w", session }, run(true));
    expect(JSON.parse(readFileSync(join(out, "done.json"), "utf8"))).toMatchObject({ event: "on_complete", ok: true, goal: "g", cost: 0.5 });
    const failed = await withRunHooks(c, root, { goal: "g", workflow: "w", session }, run(false));
    expect(existsSync(join(out, "failed.json"))).toBe(true);
    expect(failed.finalText).toContain("[warning] on_failure hook `exit 9` failed");
  });
});
