/**
 * Hooks: shell commands at lifecycle points, configured under `hooks:`.
 *
 *   before_run    before a run starts            non-zero exit blocks the run
 *   after_task    after each agent task          runs in the task's worktree; file changes are
 *                                                committed to the task (formatters, codegen)
 *   before_apply  before `apply` merges a task   runs in the task's worktree; non-zero blocks it
 *   on_failure    after a run that failed
 *   on_complete   after a run that succeeded
 *
 * Each command gets the event as JSON on stdin and YXU_EVENT in its environment. `{{…}}`
 * placeholders (e.g. {{task.files}}) are filled from the same data, shell-quoted.
 */
import type { Config } from "./config.ts";
import type { Session } from "./ops.ts";
import type { RunOutcome } from "./orchestrator/run.ts";
import { render } from "./expr.ts";
import { runVerify, type VerifyResult } from "./verify.ts";

export const HOOK_EVENTS = ["before_run", "after_task", "before_apply", "on_failure", "on_complete"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const BLOCKING: HookEvent[] = ["before_run", "before_apply"];

export interface HookRun {
  command: string;
  result: VerifyResult;
}

export interface HookOutcome {
  /** False when a blocking hook failed (the action must not happen). */
  ok: boolean;
  runs: HookRun[];
  /** Failed hooks, for reporting. */
  failed: HookRun[];
}

export function hooksFor(cfg: Config, event: HookEvent): string[] {
  return cfg.hooks?.[event] ?? [];
}

export async function runHooks(
  cfg: Config,
  event: HookEvent,
  data: Record<string, unknown>,
  opts: { cwd: string; signal?: AbortSignal },
): Promise<HookOutcome> {
  const runs: HookRun[] = [];
  const failed: HookRun[] = [];
  const payload = JSON.stringify({ event, ...data });
  for (const tpl of hooksFor(cfg, event)) {
    let command: string;
    try {
      command = render(tpl, data, { shell: true });
    } catch (e) {
      const result: VerifyResult = { ok: false, command: tpl, exitCode: null, durationMs: 0, output: `bad template: ${(e as Error).message}`, timedOut: false };
      failed.push({ command: tpl, result });
      if (BLOCKING.includes(event)) return { ok: false, runs, failed };
      continue;
    }
    const result = await runVerify(opts.cwd, command, cfg.settings.verify_timeout, opts.signal, { YXU_EVENT: event }, payload);
    runs.push({ command, result });
    if (!result.ok) {
      failed.push({ command, result });
      if (BLOCKING.includes(event)) return { ok: false, runs, failed };
    }
  }
  return { ok: true, runs, failed };
}

export function formatHookFailure(event: HookEvent, f: HookRun): string {
  const status = f.result.timedOut ? "timed out" : `exit ${f.result.exitCode}`;
  return `${event} hook \`${f.command}\` failed (${status})${f.result.output ? `:\n${f.result.output.slice(-1500)}` : ""}`;
}

/**
 * Wrap a run with before_run (may block it) and on_complete / on_failure.
 * Hook failures after the run are appended to its final text as warnings.
 */
export async function withRunHooks(
  cfg: Config,
  root: string,
  info: { goal: string; workflow: string; session: Session; signal?: AbortSignal },
  run: () => Promise<RunOutcome>,
): Promise<RunOutcome> {
  const base = { goal: info.goal, workflow: info.workflow, repo: root };
  const before = await runHooks(cfg, "before_run", base, { cwd: root, signal: info.signal });
  if (!before.ok) {
    return { runId: "blocked", ok: false, finalText: `Run blocked: ${formatHookFailure("before_run", before.failed[0]!)}`, costUsd: 0, session: info.session };
  }
  const outcome = await run();
  const event: HookEvent = outcome.ok ? "on_complete" : "on_failure";
  if (!hooksFor(cfg, event).length) return outcome;
  const tips = outcome.session.tips().map((t) => ({ id: t.taskId, agent: t.agent, files: t.filesChanged, branch: t.branch, summary: t.summary }));
  const after = await runHooks(
    cfg,
    event,
    { ...base, ok: outcome.ok, cancelled: !!outcome.cancelled, result: outcome.finalText, head: outcome.headTaskId, tasks: tips, cost: outcome.costUsd, outputs: outcome.outputs ?? {} },
    { cwd: root },
  );
  if (!after.failed.length) return outcome;
  return { ...outcome, finalText: `${outcome.finalText}\n\n${after.failed.map((f) => `[warning] ${formatHookFailure(event, f)}`).join("\n")}` };
}
