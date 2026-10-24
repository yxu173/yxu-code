/** Agent CLIs with a built-in adapter. */
export type CliName = "commandcode" | "opencode" | "claude";
/** Any agent: a built-in CLI, an ACP agent, or a generic CLI described in config. */
export type AgentKind = CliName | "acp" | "generic";

/** How a generic CLI is run and read (agents.<name> with cli: generic). */
export interface GenericSpec {
  /** argv template: {{task}}, {{model}}, {{cwd}}. */
  command: string[];
  output: "text" | "json" | "ndjson";
  /** "last-paragraph" | "all" | an expression on the output, e.g. "result" or "last.result". */
  summary: string;
  /** "exit-code" or an expression, e.g. "!is_error". */
  success: string;
  usage?: { input?: string; output?: string; cost?: string };
}

export interface AgentProfile {
  cli: AgentKind;
  /** acp: the command that starts the ACP agent. */
  command?: string[];
  generic?: GenericSpec;
  env?: Record<string, string>;
  /** Tool approvals for ACP agents: patterns "kind" or "kind:glob" (e.g. "execute:npm test*"). */
  allow?: string[];
  deny?: string[];
  /** Run inside a sandbox that only lets the agent write to its worktree. */
  sandbox?: "bwrap" | "none";
  /** Extra writable paths inside the sandbox (agent state dirs). */
  sandboxWritable?: string[];
  model?: string;
  /** yolo = no prompts, accept-edits = edits only, plan = read-only */
  permission?: "yolo" | "accept-edits" | "plan";
  maxTurns?: number;
  timeoutMs?: number;
  /** opencode --agent */
  agent?: string;
}

export interface TaskSpec {
  id: string;
  prompt: string;
  cwd: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Normalized event emitted while a subagent runs. */
export type AgentEvent =
  | { kind: "start"; sessionId?: string }
  | { kind: "tool"; name: string; status?: string; target?: string; id?: string }
  | { kind: "permission"; tool: string; decision: string }
  | { kind: "text"; text: string }
  | { kind: "error"; message: string }
  | { kind: "raw"; type: string };

/** What an adapter extracts from the CLI output; the runner adds diff and timing. */
export interface ParsedResult {
  ok: boolean;
  summary: string;
  error?: string;
  sessionId?: string;
  usage: Usage;
  costUsd?: number;
  turns?: number;
}

export interface TaskResult extends ParsedResult {
  taskId: string;
  agent: string;
  model?: string;
  exitCode: number | null;
  durationMs: number;
  diff: string;
  filesChanged: string[];
  branch?: string;
  worktree?: string;
}

export interface Adapter {
  name: AgentKind;
  /** argv (command first) to run the task headless. */
  command(task: TaskSpec, profile: AgentProfile): string[];
  /** Fold the full stdout into events + a final result. */
  parse(stdout: string, stderr: string, exitCode: number | null): {
    events: AgentEvent[];
    result: ParsedResult;
  };
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
