import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adapters } from "./adapters/index.ts";
import { collectChanges, createWorktree, removeWorktree, repoRoot, workingDiff, type Worktree } from "./git.ts";
import type { AgentProfile, TaskResult } from "./types.ts";

export interface RunOptions {
  agentName: string;
  profile: AgentProfile;
  prompt: string;
  /** Short label for the commit message (default: start of prompt). */
  title?: string;
  cwd: string;
  /** Run in an isolated git worktree (default true). */
  isolate?: boolean;
  /** Git ref the worktree starts from (default HEAD), e.g. another task's branch. */
  baseRef?: string;
  /**
   * Run inside an existing worktree owned by the caller (e.g. a merge being resolved).
   * The runner then neither commits nor removes it; the caller collects the changes.
   */
  worktree?: Worktree;
  /** Called with the task id as soon as it is assigned. */
  onStart?: (taskId: string, argv: string[]) => void;
  signal?: AbortSignal;
}

export function newTaskId(): string {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function runDir(root: string, taskId: string) {
  return join(root, ".yxu", "runs", taskId);
}

/**
 * Subagents run in their own process group so we can kill the agent and everything it
 * spawned (shells, test runners). Track live groups so they die with us.
 */
const liveGroups = new Set<number>();

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

export function killAllSubagents(signal: NodeJS.Signals = "SIGTERM") {
  for (const pid of liveGroups) killGroup(pid, signal);
}

process.on("exit", () => killAllSubagents("SIGKILL"));

/** Run one subagent task to completion and return a normalized result. */
export async function runTask(opts: RunOptions): Promise<TaskResult> {
  const adapter = adapters[opts.profile.cli];
  if (!adapter) throw new Error(`unknown cli: ${opts.profile.cli}`);

  const root = repoRoot(opts.cwd);
  const taskId = newTaskId();
  const ownWorktree = !opts.worktree && opts.isolate !== false;
  const wt = opts.worktree ?? (ownWorktree ? createWorktree(root, taskId, opts.baseRef) : undefined);
  const cwd = wt?.path ?? root;
  const argv = adapter.command({ id: taskId, prompt: opts.prompt, cwd }, opts.profile);

  opts.onStart?.(taskId, argv);
  const dir = runDir(root, taskId);
  mkdirSync(dir, { recursive: true });

  const started = Date.now();
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  liveGroups.add(proc.pid);

  let killedReason: string | undefined;
  const kill = (reason: string) => {
    killedReason ??= reason;
    killGroup(proc.pid, "SIGTERM");
    setTimeout(() => killGroup(proc.pid, "SIGKILL"), 5000).unref();
  };
  const timer = setTimeout(() => kill("timeout"), opts.profile.timeoutMs ?? 15 * 60_000);
  const onAbort = () => kill("cancelled");
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  liveGroups.delete(proc.pid);
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);

  writeFileSync(join(dir, "stdout.log"), stdout);
  writeFileSync(join(dir, "stderr.log"), stderr);

  const { events, result } = adapter.parse(stdout, stderr, exitCode);
  if (killedReason) {
    result.ok = false;
    result.error = `${killedReason}${result.error ? `: ${result.error}` : ""}`;
  }

  let changes = { diff: "", files: [] as string[] };
  let keepWorktree = false;
  if (ownWorktree && wt) {
    changes = collectChanges(wt, `yxu(${opts.agentName}): ${(opts.title ?? opts.prompt).split("\n")[0]!.slice(0, 72)}`);
    // Nothing to review: drop the empty worktree and branch, keep the run record.
    keepWorktree = changes.files.length > 0;
    if (!keepWorktree) removeWorktree(root, taskId, true);
  } else if (!wt) {
    changes = workingDiff(root);
  }

  const full: TaskResult = {
    ...result,
    taskId,
    agent: opts.agentName,
    model: opts.profile.model,
    exitCode,
    durationMs: Date.now() - started,
    diff: changes.diff,
    filesChanged: changes.files,
    branch: keepWorktree ? wt!.branch : undefined,
    worktree: keepWorktree ? wt!.path : undefined,
  };
  writeFileSync(join(dir, "events.json"), JSON.stringify(events, null, 2));
  writeTaskRecord(root, full, { prompt: opts.prompt, baseRef: opts.baseRef, argv });
  return full;
}

export function writeTaskRecord(root: string, r: TaskResult, extra: Record<string, unknown> = {}) {
  const dir = runDir(root, r.taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ ...r, ...extra }, null, 2));
}

/** Simple counting semaphore for the subagent concurrency limit. */
export class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiting.push(r));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}
