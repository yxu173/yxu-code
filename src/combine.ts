import { existsSync, readFileSync } from "node:fs";
import { prompt, resolverBase } from "./prompts.ts";
import { join } from "node:path";
import { createWorktree, git, removeWorktree, tryGit, YXU_IDENTITY } from "./git.ts";
import { newTaskId, runDir, runTask, writeTaskRecord } from "./runner.ts";
import { emptyUsage, type AgentProfile, type TaskResult } from "./types.ts";

export type TaskRecord = TaskResult & { prompt?: string; baseRef?: string; parents?: string[] };

export function readTaskRecord(root: string, id: string): TaskRecord | undefined {
  const file = join(runDir(root, id), "result.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** All tasks a task was built from (build_on chain and combine parents), oldest first. */
export function taskAncestors(root: string, id: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (tid: string) => {
    const r = readTaskRecord(root, tid);
    if (!r) return;
    const parents = [...(r.parents ?? []), ...(r.baseRef?.startsWith("yxu/") ? [r.baseRef.slice(4)] : [])];
    for (const p of parents) {
      if (seen.has(p)) continue;
      seen.add(p);
      visit(p);
      order.push(p);
    }
  };
  visit(id);
  return order;
}

const CONFLICT_MARKER = "^(<<<<<<<|>>>>>>>)( |$)";

export interface CombineOptions {
  root: string;
  taskIds: string[];
  /** Agent that resolves merge conflicts. Without one, a conflict fails the combine. */
  resolver?: { name: string; profile: AgentProfile; instructions?: string };
  signal?: AbortSignal;
  onConflict?: (files: string[], taskId: string) => void;
  onResolveStart?: (resolverTaskId: string) => void;
}

export type CombineResult = TaskResult & { parents: string[]; conflicts?: string[] };

/**
 * Merge several task branches into one new task branch, starting from the user's HEAD.
 * The result is a normal task: review it with `show`, apply it with `apply`.
 */
export async function combineTasks(opts: CombineOptions): Promise<CombineResult> {
  const { root, taskIds } = opts;
  if (taskIds.length < 2) throw new Error("combine needs at least 2 task ids");
  const records = taskIds.map((id) => {
    const r = readTaskRecord(root, id);
    if (!r) throw new Error(`unknown task ${id}`);
    if (!r.branch) throw new Error(`task ${id} has no changes to combine`);
    return r;
  });

  const started = Date.now();
  const id = newTaskId();
  // Start where the parents' chain started (your working tree at the time), so merging them is clean.
  const origin = (records[0] as TaskRecord & { origin?: string }).origin ?? "HEAD";
  const wt = createWorktree(root, id, origin);
  const usage = emptyUsage();
  let costUsd = 0;
  const resolved: string[] = [];

  const fail = (error: string, conflicts?: string[]): CombineResult => {
    tryGit(wt.path, "merge", "--abort");
    removeWorktree(root, id, true);
    const r: CombineResult = {
      ok: false,
      error,
      summary: "",
      usage,
      costUsd,
      taskId: id,
      agent: "combine",
      exitCode: null,
      durationMs: Date.now() - started,
      diff: "",
      filesChanged: [],
      parents: taskIds,
      conflicts,
    };
    writeTaskRecord(root, r, { parents: taskIds });
    return r;
  };

  for (const rec of records) {
    const merge = tryGit(wt.path, ...YXU_IDENTITY, "merge", "--no-ff", "-q", "-m", `yxu: combine ${rec.taskId}`, rec.branch!);
    if (merge.ok) continue;

    const conflicts = git(wt.path, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    if (!conflicts.length) return fail(`merging ${rec.taskId} failed: ${merge.err || merge.out}`);
    opts.onConflict?.(conflicts, rec.taskId);
    if (!opts.resolver) return fail(`merge conflict merging ${rec.taskId} in: ${conflicts.join(", ")}`, conflicts);

    const intents = records.map((r) => `- ${r.taskId}: ${(r.prompt ?? r.summary).split("\n").slice(0, 6).join(" ").slice(0, 400)}`);
    const resolve = await runTask({
      agentName: opts.resolver.name,
      profile: opts.resolver.profile,
      cwd: root,
      worktree: wt,
      signal: opts.signal,
      onStart: (rid) => opts.onResolveStart?.(rid),
      prompt: `${opts.resolver.instructions ? `${opts.resolver.instructions.trimEnd()}\n\n` : ""}${prompt(root, "conflict-resolver", resolverBase(intents.join("\n"), conflicts.join(", ")), {
        intents: intents.join("\n"),
        conflicts: conflicts.join(", "),
      })}`,
    });
    usage.inputTokens += resolve.usage.inputTokens;
    usage.outputTokens += resolve.usage.outputTokens;
    usage.cacheReadTokens += resolve.usage.cacheReadTokens;
    usage.cacheWriteTokens += resolve.usage.cacheWriteTokens;
    costUsd += resolve.costUsd ?? 0;
    if (!resolve.ok) return fail(`conflict resolver failed: ${resolve.error}`, conflicts);

    const left = tryGit(wt.path, "grep", "-l", "-E", CONFLICT_MARKER, "--", ...conflicts);
    if (left.ok && left.out) return fail(`conflict markers left in: ${left.out.split("\n").join(", ")}`, conflicts);

    git(wt.path, "add", "-A");
    const commit = tryGit(wt.path, ...YXU_IDENTITY, "commit", "-q", "--no-verify", "--no-edit");
    if (!commit.ok) return fail(`could not commit resolved merge: ${commit.err}`, conflicts);
    resolved.push(...conflicts);
  }

  const diff = git(wt.path, "diff", wt.base, "HEAD");
  const files = git(wt.path, "diff", "--name-only", wt.base, "HEAD").split("\n").filter(Boolean);
  const summary =
    `Combined ${taskIds.length} tasks (${taskIds.join(", ")}).` +
    (resolved.length ? ` ${opts.resolver!.name} resolved conflicts in ${[...new Set(resolved)].join(", ")}.` : " No conflicts.");

  const result: CombineResult = {
    ok: true,
    summary,
    usage,
    costUsd,
    taskId: id,
    agent: "combine",
    exitCode: 0,
    durationMs: Date.now() - started,
    diff,
    filesChanged: files,
    branch: wt.branch,
    worktree: wt.path,
    parents: taskIds,
  };
  writeTaskRecord(root, result, { parents: taskIds, prompt: summary, ...(origin !== "HEAD" ? { origin } : { origin: wt.base }) });
  return result;
}
