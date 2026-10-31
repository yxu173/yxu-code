import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adapters } from "./adapters/index.ts";
import { collectChanges, createWorktree, removeWorktree, repoRoot, snapshot, tryGit, workingDiff, type Worktree } from "./git.ts";
import { runAcp } from "./acp.ts";
import { genericCommand, genericParse } from "./adapters/generic.ts";
import type { Asker } from "./permissions.ts";
import { killGroup, signalGroup, start } from "./platform.ts";
import { sandboxed } from "./sandbox.ts";
import { plugins } from "./plugins.ts";
import { emptyUsage, type Adapter, type AgentEvent, type AgentProfile, type CliName, type ParsedResult, type TaskResult, type Usage } from "./types.ts";

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

// ── live control: watch, steer, pause and take over running tasks ───────────

export type LiveState = "running" | "paused" | "steering" | "user";

/** A running task the user can watch and step into (non-ACP agents). */
export class LiveControl {
  state: LiveState = "running";
  events: AgentEvent[] = [];
  sessionId?: string;
  tookOver = false;
  /** Notes for the viewer: "restarted with your message", … */
  log: string[] = [];
  readonly startedAt = Date.now();
  private pid?: number;
  private stopFor?: { kind: "steer"; message: string } | { kind: "takeover" };
  private remaining: number;
  private since = Date.now();
  private timer?: ReturnType<typeof setTimeout>;
  private userDone?: () => void;

  constructor(
    readonly taskId: string,
    readonly agent: string,
    readonly model: string | undefined,
    readonly worktree: string,
    timeoutMs: number,
    private onKill: (reason: string) => void,
  ) {
    this.remaining = timeoutMs;
  }

  attach(pid: number) {
    this.pid = pid;
    this.state = "running";
    this.arm();
    changed(this.taskId);
  }

  event(e: AgentEvent) {
    if (e.kind === "start" && e.sessionId) this.sessionId = e.sessionId;
    this.events.push(e);
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    changed(this.taskId);
  }

  /** The timeout only counts time the agent is actually running. */
  private arm() {
    clearTimeout(this.timer);
    this.since = Date.now();
    this.timer = setTimeout(() => this.stop("timeout"), Math.max(0, this.remaining));
  }

  private disarm() {
    clearTimeout(this.timer);
    this.remaining -= Date.now() - this.since;
  }

  private terminate() {
    if (!this.pid) return;
    const pid = this.pid;
    killGroup(pid, "SIGTERM");
    if (this.state === "paused") signalGroup(pid, "SIGCONT"); // a stopped process can't handle SIGTERM
    setTimeout(() => killGroup(pid, "SIGKILL"), 5000).unref();
  }

  /** Timeout or cancel: the task fails. */
  stop(reason: string) {
    this.onKill(reason);
    this.disarm();
    if (this.state !== "user") this.terminate(); // taken over: the agent has already exited
    this.userDone?.();
  }

  /** Send the agent a message: it stops and continues with it. */
  steer(message: string): string | undefined {
    if (this.state === "user") return "you have taken this task over; /done hands it back";
    if (!this.pid || this.stopFor) return "it is not running right now";
    this.stopFor = { kind: "steer", message };
    this.log.push(`you: ${message}`);
    this.state = "steering";
    this.disarm();
    this.terminate();
    changed(this.taskId);
    return undefined;
  }

  pause(): string | undefined {
    if (this.state !== "running" || !this.pid) return `it is ${this.state === "paused" ? "already paused" : "not running"}`;
    if (!signalGroup(this.pid, "SIGSTOP")) return "pausing isn't supported on this system";
    this.disarm();
    this.state = "paused";
    this.log.push("paused");
    changed(this.taskId);
    return undefined;
  }

  resume(): string | undefined {
    if (this.state !== "paused" || !this.pid) return "it isn't paused";
    signalGroup(this.pid, "SIGCONT");
    this.state = "running";
    this.log.push("resumed");
    this.arm();
    changed(this.taskId);
    return undefined;
  }

  /** Stop the agent and let the user finish in the worktree; `/done` hands the result back. */
  takeOver(): string | undefined {
    if (this.state === "user") return "you already have it";
    if (!this.pid || this.stopFor) return "it is not running right now";
    this.stopFor = { kind: "takeover" };
    this.tookOver = true;
    this.log.push("taken over by you");
    this.disarm();
    this.terminate();
    changed(this.taskId);
    return undefined;
  }

  done(): string | undefined {
    if (this.state !== "user" || !this.userDone) return "it isn't taken over";
    this.log.push("handed back");
    this.userDone();
    return undefined;
  }

  takeStop() {
    const why = this.stopFor;
    this.stopFor = undefined;
    return why;
  }

  resumed(how: string) {
    this.log.push(how);
  }

  untilUserDone(signal?: AbortSignal): Promise<void> {
    this.state = "user";
    changed(this.taskId);
    return new Promise((resolve) => {
      this.userDone = () => {
        this.userDone = undefined;
        resolve();
      };
      if (signal?.aborted) this.userDone();
      signal?.addEventListener("abort", () => this.userDone?.(), { once: true });
    });
  }

  end() {
    clearTimeout(this.timer);
    live.delete(this.taskId);
    changed(this.taskId);
  }
}

const live = new Map<string, LiveControl>();
const watchers = new Set<(taskId: string) => void>();

/** Running tasks the user can step into. */
export const liveTask = (id: string) => live.get(id);
export const liveTasks = () => [...live.values()];

/** Be told when a live task changes (new events, state). Returns an unsubscribe function. */
export function onLiveChange(fn: (taskId: string) => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function changed(taskId: string) {
  for (const w of watchers) {
    try {
      w(taskId);
    } catch {
      // a viewer's problem never stops the agent
    }
  }
}

function steerMessage(message: string): string {
  return `[A message from the user, who is watching you work]\n${message}\n\nContinue the task with this in mind.`;
}

function restartPrompt(prompt: string, message: string): string {
  return `${prompt}\n\n---\nYou were already working on this task when the user interrupted you. Your changes so far are in this directory (see \`git status\` and \`git diff\`); keep what is right. The user says:\n${message}\n\nContinue the task with this in mind.`;
}

function sumUsage(us: Usage[]): Usage {
  return us.reduce(
    (a, u) => ({
      inputTokens: a.inputTokens + u.inputTokens,
      outputTokens: a.outputTokens + u.outputTokens,
      cacheReadTokens: a.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + u.cacheWriteTokens,
    }),
    emptyUsage(),
  );
}

/** Run one subagent task to completion and return a normalized result. */
export async function runTask(opts: RunOptions): Promise<TaskResult> {
  const { profile } = opts;
  const adapter = profile.cli === "acp" || profile.cli === "generic" ? undefined : adapterFor(profile.cli);
  if (!adapter && profile.cli !== "acp" && profile.cli !== "generic") throw new Error(`unknown cli: ${profile.cli} (is the plugin that adds it loaded? see \`yxu plugins\`)`);

  const root = repoRoot(opts.cwd);
  const taskId = newTaskId();
  const ownWorktree = !opts.worktree && opts.isolate !== false;
  // A fresh task starts from your working tree as it is now (uncommitted changes included).
  const wt = opts.worktree ?? (ownWorktree ? createWorktree(root, taskId, opts.baseRef ?? snapshot(root)) : undefined);
  // Where the chain of work started: what applying it is measured against.
  const origin = !ownWorktree || !wt ? undefined : opts.baseRef?.startsWith("yxu/") ? (readOrigin(root, opts.baseRef.slice(4)) ?? wt.base) : wt.base;
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
    const parse = (out: string, err: string, code: number | null) =>
      profile.cli === "generic" ? genericParse(profile.generic!, out, err, code) : adapter!.parse(out, err, code);
    const ctl = new LiveControl(taskId, opts.agentName, profile.model, wt?.path ?? cwd, timeoutMs, (reason) => {
      killedReason ??= reason;
    });
    live.set(taskId, ctl);
    changed(taskId);
    const onAbort = () => ctl.stop("cancelled");
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const segments: { stdout: string; stderr: string; code: number | null }[] = [];
    let argvNow = argv;
    try {
      for (;;) {
        // Live events, line by line (NDJSON CLIs; whole-output CLIs report at the end).
        let partial = "";
        const proc = start(argvNow, {
          cwd,
          detached: true,
          env,
          onStdout: (chunk) => {
            if (profile.cli === "generic") return;
            const lines = (partial + chunk).split("\n");
            partial = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim().startsWith("{")) continue;
              for (const e of adapter!.parse(line, "", null).events) {
                if (e.kind === "start" && ctl.sessionId) continue; // line-by-line parsing repeats it
                ctl.event(e);
                opts.onEvent?.(taskId, e);
              }
            }
          },
        });
        liveGroups.add(proc.pid);
        ctl.attach(proc.pid);
        const out = await proc.result;
        liveGroups.delete(proc.pid);
        segments.push({ stdout: out.stdout, stderr: out.stderr, code: out.code });
        const why = ctl.takeStop();
        if (why?.kind === "steer" && !killedReason) {
          // Continue the CLI's own session when it can; otherwise start again, told what happened.
          const sessionId = parse(out.stdout, out.stderr, out.code).result.sessionId ?? ctl.sessionId;
          const resumeArgv = sessionId && adapter?.resume ? adapter.resume({ ...spec, prompt: steerMessage(why.message) }, profile, sessionId) : undefined;
          argvNow =
            resumeArgv ??
            (profile.cli === "generic"
              ? genericCommand(profile.generic!, { ...spec, prompt: restartPrompt(opts.prompt, why.message) }, profile)
              : adapter!.command({ ...spec, prompt: restartPrompt(opts.prompt, why.message) }, profile));
          if (profile.sandbox === "bwrap") argvNow = sandboxed(argvNow, { cli: profile.cli, worktree: cwd, writable: profile.sandboxWritable });
          ctl.resumed(resumeArgv ? "resumed its session" : "restarted with your message");
          continue;
        }
        if (why?.kind === "takeover" && !killedReason) await ctl.untilUserDone(opts.signal);
        break;
      }
    } finally {
      ctl.end();
      opts.signal?.removeEventListener("abort", onAbort);
    }
    const last = segments.at(-1)!;
    stdout = segments.map((x) => x.stdout).join("\n");
    stderr = segments.map((x) => x.stderr).join("\n");
    exitCode = last.code;
    parsed = parse(last.stdout, last.stderr, last.code);
    if (segments.length > 1) {
      // Earlier segments (before a steer) count too.
      const all = segments.slice(0, -1).map((x) => parse(x.stdout, x.stderr, x.code));
      parsed = { events: [...all.flatMap((p) => p.events), ...parsed.events], result: { ...parsed.result, usage: sumUsage([...all.map((p) => p.result.usage), parsed.result.usage]) } };
      const cost = [...all, { result: parsed.result }].reduce((a, p) => a + (p.result.costUsd ?? 0), 0);
      if (cost) parsed.result.costUsd = cost;
    }
    if (ctl.tookOver && !killedReason) {
      parsed.result = {
        ...parsed.result,
        ok: true,
        error: undefined,
        summary: `${parsed.result.summary.trim() ? `${parsed.result.summary.trim()}\n\n` : ""}[The user took over this task and finished it by hand in its worktree; the changes include theirs.]`,
      };
    }
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
    // An agent that checked out another branch (or detached HEAD) didn't make that branch's changes.
    const on = tryGit(wt.path, "symbolic-ref", "-q", "HEAD").out;
    if (on !== `refs/heads/${wt.branch}`) {
      const where = on ? on.replace("refs/heads/", "") : `a detached HEAD (${tryGit(wt.path, "rev-parse", "--short", "HEAD").out})`;
      const warning = `the agent switched its worktree to ${where}; that isn't its work, so nothing from it is kept`;
      tryGit(wt.path, "checkout", "-f", "-q", wt.branch);
      tryGit(wt.path, "clean", "-fdq");
      result.summary = `${result.summary}\n\n[warning] ${warning}`.trim();
      events.push({ kind: "error", message: warning });
      opts.onEvent?.(taskId, { kind: "error", message: warning });
    }
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
  writeTaskRecord(root, full, { prompt: opts.prompt, baseRef: opts.baseRef, argv, ...(origin ? { origin } : {}) });
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

/** The commit a task's chain of work started from (recorded at run time). */
export function readOrigin(root: string, id: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(runDir(root, id), "result.json"), "utf8")) as { origin?: string }).origin;
  } catch {
    return undefined;
  }
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
