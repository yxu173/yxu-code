/**
 * DEVELOPMENT ONLY — a scripted engine for `yxu tui --demo`.
 *
 * It replays a plausible run through the same render hooks the real orchestrator uses, so the
 * interface can be explored, screenshotted, and tested without spending tokens or touching git.
 * Nothing here is used by the production path; the header shows "[demo — scripted, no agents]".
 */
import type { Session } from "../ops.ts";
import type { RunOutcome } from "../orchestrator/run.ts";
import { emptyUsage, type TaskResult } from "../types.ts";
import type { Engine, TaskBackend } from "./app.ts";

const DEMO_DIFF = `diff --git a/calc.py b/calc.py
--- a/calc.py
+++ b/calc.py
@@ -40,6 +40,14 @@ def main(argv=None):
+HISTORY = "calc_history.txt"
+
+def record(op, a, b, result):
+    with open(HISTORY, "a") as f:
+        f.write(f"{op} {a} {b} = {result}\\n")
+
 def main(argv=None):
-    print(result)
+    print(result)
+    record(args.op, args.a, args.b, result)
diff --git a/test_calc.py b/test_calc.py
--- a/test_calc.py
+++ b/test_calc.py
@@ -1,3 +1,18 @@
+class TestHistory(unittest.TestCase):
+    def test_records_successful_calculation(self):
+        with tempfile.TemporaryDirectory() as d:
+            run_cli(["add", "2", "3"], cwd=d)
+            self.assertIn("add 2 3 = 5", read(d, "calc_history.txt"))
`;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("cancelled"));
    }, { once: true });
  });

function fakeResult(taskId: string, agent: string, files: string[], summary: string, ms: number, ok = true, error?: string): TaskResult {
  return {
    ok,
    summary,
    error,
    usage: emptyUsage(),
    costUsd: 0,
    taskId,
    agent,
    model: "opencode/deepseek-v4.1-flash-free",
    exitCode: ok ? 0 : 1,
    durationMs: ms,
    diff: ok ? DEMO_DIFF : "",
    filesChanged: files,
    branch: ok && files.length ? `yxu/${taskId}` : undefined,
  };
}

function track(session: Session, r: TaskResult, prompt: string, parents: string[] = []) {
  session.tasks.set(r.taskId, { ...r, prompt, parents });
}

/** Scripted context numbers for the demo (not measured). */
let demoTokens = 12_000;
const demoUsage = () => ({
  tokens: demoTokens,
  max: 200_000,
  percentage: (demoTokens / 200_000) * 100,
  autoCompact: true,
  threshold: 167_000,
  categories: [
    { name: "Messages", tokens: demoTokens - 9_000, kind: "used" },
    { name: "System prompt", tokens: 6_000, kind: "used" },
    { name: "System tools", tokens: 3_000, kind: "used" },
  ],
});

export function demoEngine(speed = 1): Engine {
  let n = 0;
  return {
    async compact({ render, abort }) {
      await sleep(900 / speed, abort.signal).catch(() => {});
      if (abort.signal.aborted) return { ok: false, error: "cancelled", costUsd: 0 };
      const pre = demoTokens;
      demoTokens = 14_000;
      const compaction = { trigger: "manual" as const, preTokens: pre, postTokens: demoTokens };
      render.compacted?.(compaction);
      return { ok: true, compaction, context: demoUsage(), costUsd: 0 };
    },
    async run({ goal, render, abort, session }) {
      const t = (ms: number) => sleep(ms / speed, abort.signal);
      const id = (suffix: string) => `20261024-demo${++n}${suffix}`;
      const h = render.hooks;
      try {
        render.textStart?.();
        for (const chunk of ["I'll look at ", "the calculator first, ", "then split the work ", "into two parallel tasks."]) {
          await t(140);
          render.textDelta?.(chunk);
        }
        const intro = "I'll look at the calculator first, then split the work into two parallel tasks.";
        render.assistantText(intro);
        render.toolCall("Glob", { pattern: "**/*.py" });
        await t(200);
        render.toolCall("Read", { file_path: "calc.py" });
        await t(200);
        render.toolCall("Read", { file_path: "test_calc.py" });
        await t(300);

        const a = id("a");
        const b = id("b");
        render.toolCall("mcp__yxu__delegate_parallel", { tasks: [{}, {}] });
        h.onDelegateStart?.({ taskId: a, agent: "coder", model: "opencode/deepseek-v4.1-flash-free", task: `Implement: ${goal}\nAppend each successful calculation to calc_history.txt.` });
        await t(250);
        h.onDelegateStart?.({ taskId: b, agent: "coder", model: "opencode/deepseek-v4.1-flash-free", task: "Write unittest tests for the history feature using a temporary directory." });
        await t(1600);
        const ra = fakeResult(a, "coder", ["calc.py"], "Added record() and a `history` subcommand to calc.py.", 1850);
        track(session, ra, goal);
        h.onDelegateEnd?.(ra);
        await t(700);
        const rb = fakeResult(b, "coder", ["test_calc.py"], "Added TestHistory with 4 cases.", 2300);
        track(session, rb, "tests");
        h.onDelegateEnd?.(rb);

        h.onCombineStart?.([a, b]);
        await t(500);
        const c = id("c");
        const rc = { ...fakeResult(c, "combine", ["calc.py", "test_calc.py"], `Combined 2 tasks (${a}, ${b}). No conflicts.`, 400), parents: [a, b] };
        track(session, rc, rc.summary, [a, b]);
        h.onCombineEnd?.(rc);

        h.onVerifyStart?.("python -m unittest -q", c);
        await t(600);
        h.onVerifyEnd?.({ ok: false, command: "python -m unittest -q", exitCode: 1, durationMs: 610, timedOut: false, output: "F.....\nFAIL: test_history_command (test_calc.TestHistory)\nAssertionError: 'no history' != ''\n\nRan 18 tests in 0.41s\n\nFAILED (failures=1)" }, c);
        render.step?.({ id: "verify", type: "fix", index: 1, total: 2, note: "verify failed, delegating a fix" });
        const f = id("f");
        h.onDelegateStart?.({ taskId: f, agent: "coder", model: "opencode/deepseek-v4.1-flash-free", task: "The check `python -m unittest -q` fails: history prints '' when the file is missing. Print 'no history'.", buildOn: c });
        await t(1400);
        const rf = fakeResult(f, "coder", ["calc.py"], "`history` now prints 'no history' when the file is missing.", 1400);
        track(session, rf, "fix", [c]);
        h.onDelegateEnd?.(rf);
        h.onVerifyStart?.("python -m unittest -q", f);
        await t(500);
        h.onVerifyEnd?.({ ok: true, command: "python -m unittest -q", exitCode: 0, durationMs: 520, timedOut: false, output: "..................\nRan 18 tests in 0.39s\n\nOK" }, f);

        render.textStart?.();
        const final = [
          "History is in place and **all 18 tests pass**.",
          "",
          "- `calc.py` records each successful calculation as `op a b = result`",
          "- `python calc.py history` prints the log, or `no history`",
          "- tests run in a temporary directory",
          "",
          "```python",
          "def record(op, a, b, result):",
          "    with open(HISTORY, \"a\") as f:",
          "        f.write(f\"{op} {a} {b} = {result}\\n\")",
          "```",
          "",
          `Nothing is applied yet — task \`${f}\` is ready for review.`,
        ].join("\n");
        for (const piece of final.match(/[\s\S]{1,24}/g) ?? []) {
          await t(35);
          render.textDelta?.(piece);
        }
        render.assistantText(final);
        demoTokens += 38_000;
        return { runId: `demo-${n}`, ok: true, finalText: final, costUsd: 0, session, headTaskId: f, sdkSessionId: "demo-session", context: demoUsage() } satisfies RunOutcome;
      } catch {
        return { runId: `demo-${n}`, ok: false, finalText: "cancelled", costUsd: 0, session, cancelled: true } satisfies RunOutcome;
      }
    },
  };
}

/** In-memory task backend for the demo: never touches git. */
export function demoBackend(session: () => Session): TaskBackend {
  const gone = new Set<string>();
  return {
    exists: (id) => !gone.has(id) && !!session().tasks.get(id)?.branch,
    diff: (id) => (session().tasks.get(id)?.branch ? DEMO_DIFF : ""),
    apply: (id) => {
      gone.add(id);
      return { ok: true, message: `merged yxu/${id} into your branch (demo: nothing was changed)` };
    },
    discard: (id) => {
      gone.add(id);
      return { ok: true, message: `discarded ${id} (demo)` };
    },
  };
}
