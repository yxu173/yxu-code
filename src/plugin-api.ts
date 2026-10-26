/**
 * The yxu plugin API, version 1. A plugin is a TypeScript (or JavaScript) module whose default
 * export is a plugin object:
 *
 *   import type { Plugin } from "yxu/plugin";      // types only; erased at runtime
 *   export default {
 *     name: "todos",
 *     apiVersion: 1,
 *     commands: [{ name: "fix", description: "Fix one TODO", run: (ctx, args) => ctx.run(`Fix the TODO in ${args[0]}`) }],
 *     panel: [{ title: "todos", render: (ctx) => [`${count(ctx.root)} open`] }],
 *   } satisfies Plugin;
 *
 * Plugins run inside yxu with your permissions: they are trusted code. Plugins from a repo or a
 * project pack load only after you approve them (`yxu plugins approve`), and again whenever
 * their code changes. Everything here is stable within apiVersion 1.
 */
import type { AgentEvent, AgentProfile, ParsedResult, TaskSpec } from "./types.ts";

export const PLUGIN_API_VERSION = 1;

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What a plugin gets when yxu calls it. */
export interface PluginContext {
  /** The plugin's name. */
  plugin: string;
  /** The repository root. */
  root: string;
  /** The effective config (read-only). */
  config: Readonly<Record<string, unknown>>;
  /** Show a Markdown note in the interface (printed in `yxu run`). */
  note(markdown: string): void;
  /**
   * Start a run with the orchestrator, as if the user typed the goal. With `workflow`, run that
   * workflow (and `inputs` for pipelines). Resolves when the run has finished.
   */
  run(goal: string, opts?: { workflow?: string; inputs?: Record<string, string> }): Promise<{ ok: boolean; result: string }>;
  /** Run a shell command (in the repo unless `cwd` says otherwise). */
  shell(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ShellResult>;
  /** Small persistent storage for this plugin (in .yxu/plugin-data/<plugin>.json). */
  data: { get<T = unknown>(key: string): T | undefined; set(key: string, value: unknown): void };
}

export interface PluginCommand {
  /** Typed as /<plugin>:<name>. Lowercase words. */
  name: string;
  description?: string;
  /** Shown after the name, e.g. "<ticket-id>". */
  usage?: string;
  run(ctx: PluginContext, args: string[]): void | Promise<void>;
}

export interface PluginPanel {
  /** Section title in the side panel (and its id in ui.panel_sections: "<plugin>:<title>"). */
  title: string;
  /** Lines to show (plain text; long lines are cut). Called at start, after each task, and every `refresh` seconds. */
  render(ctx: PluginContext): string[] | Promise<string[]>;
  /** Seconds between refreshes while the interface is open (default: only after tasks). */
  refresh?: number;
}

/** Hook data is the same JSON shell hooks get on stdin. Return false (or throw) from a before_* hook to block. */
export interface PluginHooks {
  before_run?(ctx: PluginContext, event: Record<string, unknown>): void | boolean | Promise<void | boolean>;
  after_task?(ctx: PluginContext, event: Record<string, unknown>): void | Promise<void>;
  before_apply?(ctx: PluginContext, event: Record<string, unknown>): void | boolean | Promise<void | boolean>;
  on_failure?(ctx: PluginContext, event: Record<string, unknown>): void | Promise<void>;
  on_complete?(ctx: PluginContext, event: Record<string, unknown>): void | Promise<void>;
}

/**
 * A new kind of agent: `agents: { x: { cli: <cli>, model: … } }`. Works like the built-in
 * adapters: yxu runs the command in the task's worktree (with timeouts, cancel, sandbox) and
 * hands you its output to read.
 */
export interface PluginAgent {
  cli: string;
  description?: string;
  command(task: TaskSpec, profile: AgentProfile): string[];
  parse(stdout: string, stderr: string, exitCode: number | null): { events: AgentEvent[]; result: ParsedResult };
}

/** One structured answer for a pipeline plan or review step (`orchestrator.provider: <name>`). */
export interface OrchestratorRequest {
  system: string;
  prompt: string;
  /** JSON Schema the answer must match. */
  schema: Record<string, unknown>;
  signal: AbortSignal;
  root: string;
}

export interface PluginOrchestrator {
  name: string;
  description?: string;
  ask(req: OrchestratorRequest): Promise<{ value: unknown; costUsd?: number }>;
}

export interface Plugin {
  name: string;
  apiVersion: number;
  description?: string;
  commands?: PluginCommand[];
  panel?: PluginPanel[];
  hooks?: PluginHooks;
  agents?: PluginAgent[];
  orchestrators?: PluginOrchestrator[];
  issues?: PluginIssueSource[];
}

/** An issue tracker: `yxu run --issue <name>:<id>` (e.g. linear:ENG-12, jira:PROJ-7). */
export interface PluginIssueSource {
  name: string;
  description?: string;
  fetch(id: string, ctx: PluginContext): Promise<PluginIssue> | PluginIssue;
}

export interface PluginIssue {
  /** As the tracker shows it, e.g. ENG-12. */
  id: string;
  title: string;
  body?: string;
  url?: string;
  labels?: string[];
  comments?: { author: string; body: string }[];
}

/** Optional helper for type checking without `satisfies`. */
export const definePlugin = (p: Plugin): Plugin => p;
