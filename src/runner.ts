import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adapters } from "./adapters/index.ts";
import { collectChanges, createWorktree, removeWorktree, repoRoot, tryGit, workingDiff, type Worktree } from "./git.ts";
import { runAcp } from "./acp.ts";
import { genericCommand, genericParse } from "./adapters/generic.ts";
import type { Asker } from "./permissions.ts";
import { killGroup, start } from "./platform.ts";
import { sandboxed } from "./sandbox.ts";
import { plugins } from "./plugins.ts";
import type { Adapter, AgentEvent, AgentProfile, CliName, ParsedResult, TaskResult } from "./types.ts";

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
  /** Live events while the agent works (ACP agents stream them). */
  onEvent?: (taskId: string, e: AgentEvent) => void;
  /** Ask the user about a tool the permission policy can't decide (ACP agents). */
  ask?: Asker;
  /** "Always" approvals remembered for the session. */
  always?: Set<string>;
  signal?: AbortSignal;
}

/** A built-in adapter, or one a loaded plugin adds. */
function adapterFor(cli: string): Adapter | undefined {
  if (cli in adapters) return adapters[cli as CliName];
  const p = plugins().agents.get(cli);
  return p ? { name: cli, command: (t, prof) => p.agent.command(t, prof), parse: (o, e, c) => p.agent.parse(o, e, c) } : undefined;
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

export function killAllSubagents(signal: NodeJS.Signals = "SIGTERM") {
  for (const pid of liveGroups) killGroup(pid, signal);
}

process.on("exit", () => killAllSubagents("SIGKILL"));

/** Run one subagent task to completion and return a normalized result. */
export async function runTask(opts: RunOptions): Promise<TaskResult> {
  const { profile } = opts;
  const adapter = profile.cli === "acp" || profile.cli === "generic" ? undefined : adapterFor(profile.cli);
  if (!adapter && profile.cli !== "acp" && profile.cli !== "generic") throw new Error(`unknown cli: ${profile.cli} (is the plugin that adds it loaded? see \`yxu plugins\`)`);

  const root = repoRoot(opts.cwd);
  const taskId = newTaskId();
  const ownWorktree = !opts.worktree && opts.isolate !== false;
  const wt = opts.worktree ?? (ownWorktree ? createWorktree(root, taskId, opts.baseRef) : undefined);
  const cwd = wt?.path ?? root;
  const spec = { id: taskId, prompt: opts.prompt, cwd };
  let argv = profile.cli === "acp" ? profile.command! : profile.cli === "generic" ? genericCommand(profile.generic!, spec, profile) : adapter!.command(spec, profile);
  if (profile.sandbox === "bwrap") {
    try {
      argv = sandboxed(argv, { cli: profile.cli, worktree: cwd, writable: profile.sandboxWritable });
    } catch (e) {
      if (ownWorktree && wt) removeWorktree(root, taskId, true);
      throw e;
    }
  }
  const env = { ...process.env, NO_COLOR: "1", ...profile.env };

  // To notice an agent that writes outside its worktree (into the user's checkout).
  const checkoutBefore = ownWorktree ? checkoutState(root) : undefined;
  opts.onStart?.(taskId, argv);
  const dir = runDir(root, taskId);
  mkdirSync(dir, { recursive: true });

  const started = Date.now();
  let killedReason: string | undefined;
  let stdout: string;
  let stderr: string;
  let exitCode: number | null;
  let parsed: { events: AgentEvent[]; result: ParsedResult };
  const timeoutMs = profile.timeoutMs ?? 15 * 60_000;

  if (profile.cli === "acp") {
    let pid: number | undefined;
    const out = await runAcp({
      agent: opts.agentName,
      argv,
      cwd,
      env,
      prompt: opts.prompt,
      profile,
      signal: opts.signal,
      timeoutMs,
      ask: opts.ask,
      always: opts.always,
      onEvent: (e) => opts.onEvent?.(taskId, e),
      onPid: (p) => liveGroups.add((pid = p)),
    });
    if (pid) liveGroups.delete(pid);
    ({ transcript: stdout, stderr, exitCode } = out);
    parsed = { events: out.events, result: out.result };
  } else {
    const proc = start(argv, { cwd, detached: true, env });
    liveGroups.add(proc.pid);
    const kill = (reason: string) => {
      killedReason ??= reason;
      killGroup(proc.pid, "SIGTERM");
      setTimeout(() => killGroup(proc.pid, "SIGKILL"), 5000).unref();
    };
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    const onAbort = () => kill("cancelled");
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    ({ code: exitCode, stdout, stderr } = await proc.result);
    liveGroups.delete(proc.pid);
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    parsed = profile.cli === "generic" ? genericParse(profile.generic!, stdout, stderr, exitCode) : adapter!.parse(stdout, stderr, exitCode);
  }

  writeFileSync(join(dir, "stdout.log"), stdout);
  writeFileSync(join(dir, "stderr.log"), stderr);

  const { events, result } = parsed;
  if (killedReason) {
    result.ok = false;
    result.error = `${killedReason}${result.error ? `: ${result.error}` : ""}`;
  }

  if (checkoutBefore !== undefined) {
    const touched = changedSince(checkoutBefore, checkoutState(root));
    if (touched.length) {
      const warning = `wrote outside its worktree, into your checkout: ${touched.slice(0, 8).join(", ")}${touched.length > 8 ? ", …" : ""}. Check \`git status\`; for generic agents pass {{cwd}} to the CLI, or use sandbox: bwrap`;
      result.summary = `${result.summary}\n\n[warning] ${warning}`.trim();
      events.push({ kind: "error", message: warning });
      opts.onEvent?.(taskId, { kind: "error", message: warning });
    }
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

/** `git status` lines of the user's checkout, minus yxu's own files. */
function checkoutState(root: string): Map<string, string> {
  const out = tryGit(root, "status", "--porcelain", "--untracked-files=all").out;
  const m = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const path = line.slice(3);
    if (path.startsWith(".yxu/")) continue;
    // Include the content hash, so a second edit to an already-dirty file is noticed too.
    m.set(path, `${line.slice(0, 2)}:${tryGit(root, "hash-object", "--", path).out}`);
  }
  return m;
}

function changedSince(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
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
