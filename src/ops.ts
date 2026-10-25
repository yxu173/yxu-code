import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { combineTasks, readTaskRecord } from "./combine.ts";
import { toProfile, type Config } from "./config.ts";
import { taskData } from "./actions.ts";
import { branchFor, collectChanges, createWorktree, git, removeWorktree, worktreeFor, YXU_IDENTITY } from "./git.ts";
import { formatHookFailure, hooksFor, runHooks } from "./hooks.ts";
import { newTaskId, runTask, Semaphore, writeTaskRecord } from "./runner.ts";
import { prompt, SUBAGENT_PREAMBLE } from "./prompts.ts";
import type { Asker } from "./permissions.ts";
import { guard, untrustedYolo } from "./trust.ts";
import { emptyUsage, type AgentEvent, type TaskResult } from "./types.ts";
import { formatVerify, runVerify, type VerifyResult } from "./verify.ts";

export interface OpsHooks {
  onDelegateStart?: (info: { taskId: string; agent: string; model?: string; task: string; buildOn?: string }) => void;
  onDelegateEnd?: (result: TaskResult) => void;
  /** Live progress from agents that stream it (ACP). */
  onAgentEvent?: (taskId: string, e: AgentEvent) => void;
  onCombineStart?: (taskIds: string[]) => void;
  onConflict?: (files: string[], taskId: string) => void;
  onCombineEnd?: (result: TaskResult) => void;
  onVerifyStart?: (command: string, taskId?: string) => void;
  onVerifyEnd?: (result: VerifyResult, taskId?: string) => void;
  onShellStart?: (info: { id: string; command: string; buildOn?: string }) => void;
  onShellEnd?: (info: { id: string; result: VerifyResult; task?: TaskResult }) => void;
  onDiscard?: (taskId: string) => void;
}

export type SessionTask = TaskResult & { prompt: string; parents: string[]; discarded?: boolean };

/** Tasks produced during one orchestrator session, in order. */
export class Session {
  tasks = new Map<string, SessionTask>();
  /** Tool approvals answered "always" during this session. */
  always = new Set<string>();
  /** Tasks that still have reviewable changes on a branch. */
  pending() {
    return [...this.tasks.values()].filter((t) => t.branch && !t.discarded);
  }
  /** Pending tasks no other pending task builds on: these are what the user applies. */
  tips() {
    const pending = this.pending();
    return pending.filter((t) => !pending.some((o) => o.parents.includes(t.taskId)));
  }
  /** Number of tasks folded into this one (transitively). */
  ancestorCount(id: string): number {
    const seen = new Set<string>();
    const walk = (tid: string) => {
      for (const p of this.tasks.get(tid)?.parents ?? []) {
        if (!seen.has(p)) {
          seen.add(p);
          walk(p);
        }
      }
    };
    walk(id);
    return seen.size;
  }
  /** Persist a JSON snapshot (diffs omitted) so other processes can read the outcome. */
  save(path: string, meta: Record<string, unknown> = {}) {
    mkdirSync(dirname(path), { recursive: true });
    const tasks = [...this.tasks.values()].map(({ diff, ...t }) => t);
    const tips = this.tips().map((t) => ({ taskId: t.taskId, agent: t.agent, includes: this.ancestorCount(t.taskId) }));
    writeFileSync(path, JSON.stringify({ ...meta, tips, tasks }, null, 2));
  }
}

export { SUBAGENT_PREAMBLE } from "./prompts.ts";

function truncate(diff: string, max: number): string {
  if (diff.length <= max) return diff;
  return `${diff.slice(0, max)}\n… [diff truncated: ${diff.length - max} more chars; call get_diff for the full diff]`;
}

/** Everything yxu can do with tasks; shared by the orchestrator tools and the pipeline engine. */
export class TaskOps {
  readonly slots: Semaphore;
  readonly allowed: string[];

  constructor(
    readonly cfg: Config,
    readonly root: string,
    readonly session: Session,
    readonly opts: { allowedAgents?: string[]; signal?: AbortSignal; hooks?: OpsHooks; onChange?: () => void; ask?: Asker } = {},
  ) {
    this.slots = new Semaphore(cfg.settings.concurrency);
    this.allowed = opts.allowedAgents ?? Object.keys(cfg.agents);
  }

  private get hooks() {
    return this.opts.hooks ?? {};
  }

  /** Validate an agent + build_on; returns the base ref to start from, or an error. */
  check(agent: string, buildOn?: string): { baseRef?: string } | { error: string } {
    if (!this.cfg.agents[agent] || !this.allowed.includes(agent)) {
      return { error: `Unknown or disallowed agent "${agent}". Allowed: ${this.allowed.join(", ")}` };
    }
    if (!buildOn) return {};
    const prev = this.session.tasks.get(buildOn);
    if (!prev) return { error: `Unknown task_id "${buildOn}".` };
    if (prev.discarded) return { error: `Task ${buildOn} was discarded.` };
    return { baseRef: prev.branch }; // undefined when the earlier task made no changes → start from HEAD
  }

  async delegate(agent: string, task: string, buildOn?: string): Promise<TaskResult> {
    const base = this.check(agent, buildOn);
    if ("error" in base) throw new Error(base.error);
    const def = this.cfg.agents[agent]!;
    if (def.command) guard(this.cfg, `agents.${agent}.command`, `agent ${agent}'s command \`${def.command.join(" ")}\``);
    return this.slots.run(async () => {
      if (this.opts.signal?.aborted) throw new Error("run cancelled");
      const profile = toProfile(def);
      // A cloned repo can't give its agents yolo until the user trusts it.
      if (untrustedYolo(this.cfg, agent)) profile.permission = "accept-edits";
      const result = await runTask({
        agentName: agent,
        profile,
        prompt: prompt(this.root, "subagent-preamble", SUBAGENT_PREAMBLE) + task,
        title: task,
        cwd: this.root,
        baseRef: base.baseRef,
        signal: this.opts.signal,
        ask: this.opts.ask,
        always: this.session.always,
        onEvent: (taskId, e) => this.hooks.onAgentEvent?.(taskId, e),
        onStart: (taskId) => this.hooks.onDelegateStart?.({ taskId, agent, model: profile.model, task, buildOn }),
      });
      if (result.branch && hooksFor(this.cfg, "after_task").length) await this.afterTask(result);
      this.session.tasks.set(result.taskId, { ...result, prompt: task, parents: buildOn ? [buildOn] : [] });
      this.hooks.onDelegateEnd?.(result);
      this.opts.onChange?.();
      return result;
    });
  }

  /** after_task hooks run in the task's worktree; what they change is committed to the task. */
  private async afterTask(r: TaskResult) {
    const wt = worktreeFor(this.root, r.taskId);
    const h = await runHooks(this.cfg, "after_task", { task: taskData(r) }, { cwd: wt, signal: this.opts.signal });
    if (h.runs.length && git(wt, "status", "--porcelain")) {
      git(wt, "add", "-A");
      git(wt, ...YXU_IDENTITY, "commit", "-q", "--no-verify", "-m", "yxu(after_task hooks)");
      // The task is its agent's commit plus this one.
      r.diff = git(wt, "diff", "HEAD~2", "HEAD");
      r.filesChanged = git(wt, "diff", "--name-only", "HEAD~2", "HEAD").split("\n").filter(Boolean);
      const rec = readTaskRecord(this.root, r.taskId);
      if (rec) writeTaskRecord(this.root, { ...rec, diff: r.diff, filesChanged: r.filesChanged });
    }
    for (const f of h.failed) r.summary = `${r.summary}\n\n[warning] ${formatHookFailure("after_task", f)}`;
  }

  /** Run tasks concurrently (bounded by the semaphore). Validates all before starting any. */
  async delegateMany(tasks: { agent: string; task: string; buildOn?: string }[]) {
    for (const t of tasks) {
      const base = this.check(t.agent, t.buildOn);
      if ("error" in base) throw new Error(`Nothing was started. ${base.error}`);
    }
    return Promise.allSettled(tasks.map((t) => this.delegate(t.agent, t.task, t.buildOn)));
  }

  async combine(taskIds: string[], resolver?: string) {
    for (const id of taskIds) {
      const t = this.session.tasks.get(id);
      if (!t) throw new Error(`Unknown task_id "${id}".`);
      if (t.discarded || !t.branch) throw new Error(`Task ${id} has no changes to combine.`);
    }
    const resolverName = resolver ?? this.cfg.settings.resolver;
    if (resolverName && !this.cfg.agents[resolverName]) throw new Error(`Unknown resolver agent "${resolverName}".`);
    this.hooks.onCombineStart?.(taskIds);
    const result = await this.slots.run(() =>
      combineTasks({
        root: this.root,
        taskIds,
        resolver: resolverName ? { name: resolverName, profile: toProfile(this.cfg.agents[resolverName]!) } : undefined,
        signal: this.opts.signal,
        onConflict: this.hooks.onConflict,
      }),
    );
    if (result.ok) this.session.tasks.set(result.taskId, { ...result, prompt: result.summary, parents: taskIds });
    this.hooks.onCombineEnd?.(result);
    this.opts.onChange?.();
    return result;
  }

  /** Run the verify command in a task's worktree (or the user's checkout when no task is given). */
  async verify(taskId?: string, command?: string): Promise<VerifyResult> {
    const cmd = command ?? this.cfg.settings.verify;
    if (!cmd) throw new Error("No verify command: pass one, or set settings.verify in yxu.yaml.");
    if (!command) guard(this.cfg, "settings.verify", `the verify command \`${cmd}\``);
    let cwd = this.root;
    if (taskId) {
      const t = this.session.tasks.get(taskId);
      if (!t) throw new Error(`Unknown task_id "${taskId}".`);
      if (t.branch && !t.discarded) cwd = worktreeFor(this.root, taskId);
    }
    this.hooks.onVerifyStart?.(cmd, taskId);
    const result = await runVerify(cwd, cmd, this.cfg.settings.verify_timeout, this.opts.signal);
    this.hooks.onVerifyEnd?.(result, taskId);
    return result;
  }

  /**
   * Run a workflow shell step in a fresh worktree on top of `buildOn` (or HEAD), never in the
   * user's checkout. Files it changes become a task, like an agent's work.
   */
  async shell(
    id: string,
    command: string,
    buildOn?: string,
    opts: { timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<{ result: VerifyResult; task?: TaskResult }> {
    const prev = buildOn ? this.session.tasks.get(buildOn) : undefined;
    if (buildOn && !prev) throw new Error(`Unknown task_id "${buildOn}".`);
    const taskId = newTaskId();
    const wt = createWorktree(this.root, taskId, prev?.branch);
    this.hooks.onShellStart?.({ id, command, buildOn });
    let result: VerifyResult;
    let task: TaskResult | undefined;
    try {
      result = await runVerify(wt.path, command, opts.timeoutMs ?? this.cfg.settings.verify_timeout, this.opts.signal, opts.env);
      const changes = collectChanges(wt, `yxu(shell ${id}): ${command.split("\n")[0]!.slice(0, 60)}`);
      if (changes.files.length) {
        task = {
          taskId,
          agent: "shell",
          ok: result.ok,
          summary: `\`${command}\` changed ${changes.files.length} file(s)`,
          error: result.ok ? undefined : `exit ${result.exitCode}`,
          usage: emptyUsage(),
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          diff: changes.diff,
          filesChanged: changes.files,
          branch: wt.branch,
          worktree: wt.path,
        };
        this.session.tasks.set(taskId, { ...task, prompt: command, parents: buildOn ? [buildOn] : [] });
        writeTaskRecord(this.root, task, { prompt: command, baseRef: prev?.branch });
      }
    } finally {
      if (!task) removeWorktree(this.root, taskId, true);
    }
    this.hooks.onShellEnd?.({ id, result, task });
    this.opts.onChange?.();
    return { result, task };
  }

  discard(taskId: string) {
    const t = this.session.tasks.get(taskId);
    if (!t) throw new Error(`Unknown task_id "${taskId}".`);
    const dependents = this.session.pending().filter((p) => p.parents.includes(taskId));
    if (dependents.some((d) => d.agent !== "combine")) {
      throw new Error(`Task ${taskId} has pending tasks built on it; discard those first.`);
    }
    // A combined task already contains its parents' commits, so dropping the parent branches is safe.
    removeWorktree(this.root, taskId, true);
    t.discarded = true;
    this.hooks.onDiscard?.(taskId);
    this.opts.onChange?.();
  }

  /** Diff of a task alone, or cumulative from the user's HEAD. */
  diff(taskId: string, cumulative = false): string {
    const t = this.session.tasks.get(taskId);
    if (!t) throw new Error(`Unknown task_id "${taskId}".`);
    if (!t.branch) return "";
    return cumulative ? git(this.root, "diff", `HEAD...${branchFor(taskId)}`) : t.diff;
  }

  format(r: TaskResult, extra: string[] = []): string {
    return [
      `task_id: ${r.taskId}`,
      `status: ${r.ok ? "success" : "failed"}`,
      r.error ? `error: ${r.error}` : undefined,
      ...extra,
      `duration: ${(r.durationMs / 1000).toFixed(0)}s`,
      `files_changed: ${r.filesChanged.join(", ") || "(none)"}`,
      `summary:\n${r.summary || "(none)"}`,
      r.diff ? `diff:\n${truncate(r.diff, this.cfg.settings.max_diff_chars)}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  formatVerify = formatVerify;
}
