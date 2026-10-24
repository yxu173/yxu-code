export type CliName = "commandcode" | "opencode" | "claude";

export interface AgentProfile {
  cli: CliName;
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
  | { kind: "tool"; name: string; status?: string; target?: string }
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
  name: CliName;
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
