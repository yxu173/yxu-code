/**
 * `yxu fix-ci <pr>`: read why a pull request's CI fails, have an agent (the debugger) fix it on top
 * of the PR's head, check it with the verify command, and push the fix to the PR's branch.
 */
import type { Config } from "./config.ts";
import { branchFor, git } from "./git.ts";
import { failedLogs, fetchPrHead, viewPr, type PrInfo } from "./github.ts";
import { Session, TaskOps, type OpsHooks } from "./ops.ts";
import type { TaskResult } from "./types.ts";

export interface FixCiOptions {
  agent?: string;
  /** Fix rounds when the verify command still fails (default 2). */
  rounds?: number;
  /** Asked before pushing; without it, nothing is pushed. */
  confirmPush?: (message: string) => Promise<boolean>;
  print: (line: string) => void;
  hooks?: OpsHooks;
  signal?: AbortSignal;
}

export interface FixCiResult {
  status: "fixed" | "passing" | "pending" | "failed";
  message: string;
  taskId?: string;
  pushed?: boolean;
  pr?: PrInfo;
}

/** The agent that fixes CI: --agent, else `debugger`, else the default agent. */
export function ciAgent(cfg: Config, agent?: string): string {
  const name = agent ?? (cfg.agents.debugger ? "debugger" : (cfg.settings.default_agent ?? Object.keys(cfg.agents)[0]));
  if (!name || !cfg.agents[name]) throw new Error(`no agent "${agent ?? "debugger"}" (see \`yxu agents\`)`);
  return name;
}

export function ciTask(pr: PrInfo, logs: string): string {
  const failing = pr.checks.filter((c) => c.state === "fail");
  return [
    `CI fails on pull request #${pr.number} "${pr.title}" (branch ${pr.headRefName}). Your working copy is that branch.`,
    `Failing checks:\n${failing.map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ""}`).join("\n")}`,
    logs.trim() ? `The end of each failed job's log:\n${logs}` : "The logs could not be read (not GitHub Actions); reproduce the failure locally from the check names.",
    "Find the root cause and fix the code so these checks pass. Reproduce locally first when you can (run the failing command). " +
      "Do not disable checks, skip or delete tests, or loosen assertions unless they are clearly wrong; say so if you do. " +
      "If the failure is not caused by this branch (e.g. a flaky test or an outage), change nothing and explain why.",
  ].join("\n\n");
}

export async function fixCi(root: string, cfg: Config, prRef: string, o: FixCiOptions): Promise<FixCiResult> {
  const pr = viewPr(root, prRef);
  const failing = pr.checks.filter((c) => c.state === "fail");
  if (!failing.length) {
    const pending = pr.checks.filter((c) => c.state === "pending");
    return pending.length
      ? { status: "pending", pr, message: `CI on #${pr.number} is still running (${pending.map((c) => c.name).join(", ")}); try again when it has failed` }
      : { status: "passing", pr, message: `CI on #${pr.number} is not failing; nothing to fix` };
  }
  const agent = ciAgent(cfg, o.agent);
  o.print(`#${pr.number} ${pr.title}: ${failing.length} failing check(s): ${failing.map((c) => c.name).join(", ")}`);
  const logs = failedLogs(root, pr.checks);
  const head = fetchPrHead(root, pr);
  const ops = new TaskOps(cfg, root, new Session(), { signal: o.signal, hooks: o.hooks });

  const rounds = o.rounds ?? 2;
  let task = ciTask(pr, logs);
  let last: TaskResult | undefined;
  for (let round = 1; round <= rounds; round++) {
    const r = await ops.delegate(agent, task, last?.taskId, last ? undefined : { ref: head, title: `Fix CI: ${failing.map((c) => c.name).join(", ")}`.slice(0, 72) });
    if (!r.ok) return { status: "failed", pr, taskId: last?.taskId, message: `${agent} failed: ${r.error ?? "unknown error"}` };
    if (!r.branch) {
      if (last) break; // nothing more to change
      return { status: "failed", pr, message: `${agent} made no changes:\n${r.summary}` };
    }
    last = r;
    if (!cfg.settings.verify) break;
    const v = await ops.verify(r.taskId);
    if (v.ok) break;
    if (round === rounds) return { status: "failed", pr, taskId: r.taskId, message: `\`${cfg.settings.verify}\` still fails after ${rounds} round(s); the attempt is task ${r.taskId} (yxu show ${r.taskId})` };
    task = `The fix for the CI failure of #${pr.number} is in your working copy, but \`${cfg.settings.verify}\` still fails. Fix that too.\n\nOutput:\n${v.output.slice(-6000)}`;
  }
  if (!last) return { status: "failed", pr, message: "no fix was made" };

  const commits = git(root, "rev-list", "--count", `${head}..${branchFor(last.taskId)}`);
  if (pr.isCrossRepository) {
    return { status: "fixed", pr, taskId: last.taskId, pushed: false, message: `fixed in task ${last.taskId}. #${pr.number} comes from a fork, so yxu doesn't push; push ${branchFor(last.taskId)} to the fork's ${pr.headRefName} yourself` };
  }
  const where = `origin/${pr.headRefName}`;
  const ok = (await o.confirmPush?.(`push ${commits} commit(s) fixing CI to ${where} (#${pr.number})?`)) ?? false;
  if (!ok) {
    return { status: "fixed", pr, taskId: last.taskId, pushed: false, message: `fixed in task ${last.taskId}, not pushed. Push it with: git push origin ${branchFor(last.taskId)}:${pr.headRefName}` };
  }
  // No force: if someone pushed to the PR meanwhile, this fails instead of overwriting their work.
  git(root, "push", "--quiet", "origin", `${branchFor(last.taskId)}:refs/heads/${pr.headRefName}`);
  return { status: "fixed", pr, taskId: last.taskId, pushed: true, message: `pushed ${commits} commit(s) to ${where}; CI runs again on #${pr.number} (${pr.url})` };
}
