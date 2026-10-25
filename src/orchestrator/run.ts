import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeExecutable, VERSION } from "../platform.ts";
import { ORCHESTRATOR_BASE, prompt } from "../prompts.ts";
import { join } from "node:path";
import { z } from "zod";
import type { Config, Workflow } from "../config.ts";
import { buildContextPrompt, compactInstructions, compactSettings, settingSources, type ContextUsage, type IncludedFile } from "../context.ts";
import { Session, TaskOps, type OpsHooks } from "../ops.ts";
import { newTaskId } from "../runner.ts";
import { createYxuServer, SERVER_NAME, TOOL_NAMES } from "./tools.ts";

/** Read-only built-ins so the orchestrator can study the code but never edit it. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

export function orchestratorPrompt(workflow: Workflow & { name?: string }, root?: string): string {
  const base = root ? prompt(root, "orchestrator", ORCHESTRATOR_BASE, { workflow }) : ORCHESTRATOR_BASE;
  return `\n${base.trimEnd()}\n${workflow.instructions ? `\n## Workflow instructions (from yxu.yaml)\n${workflow.instructions}` : ""}`;
}

export interface RunOutcome {
  runId: string;
  ok: boolean;
  finalText: string;
  costUsd: number;
  session: Session;
  /** The task the user should apply, when the run produced a single result. */
  headTaskId?: string;
  /** Claude session id; pass back as `resume` to continue the same conversation. */
  sdkSessionId?: string;
  cancelled?: boolean;
  /** Pipeline workflows: the values of their declared outputs. */
  outputs?: Record<string, string>;
  /** Context-window usage at the end of the run, when Claude Code reported it. */
  context?: ContextUsage;
  /** Files from context.include that were (or could not be) added. */
  contextFiles?: IncludedFile[];
}

export interface OrchestratorRender {
  assistantText(text: string): void;
  toolCall(name: string, input: Record<string, unknown>): void;
  hooks: OpsHooks;
  /** Pipeline progress. */
  step?(info: { id: string; type: string; index: number; total: number; note?: string }): void;
  /** Streaming: a new assistant text block begins / receives a chunk. assistantText() finalizes it. */
  textStart?(): void;
  textDelta?(chunk: string): void;
  /** The orchestrator conversation was summarized (automatically or on request). */
  compacted?(info: CompactInfo): void;
}

export interface CompactInfo {
  trigger: "auto" | "manual";
  preTokens: number;
  postTokens?: number;
}

function baseOptions(cfg: Config, root: string, abort: AbortController): Options {
  return {
    cwd: root,
    model: cfg.orchestrator.model,
    effort: cfg.orchestrator.effort,
    maxTurns: cfg.orchestrator.max_turns,
    abortController: abort,
    tools: READ_ONLY_TOOLS,
    permissionMode: "dontAsk",
    // Isolate from the user's global plugins, hooks and MCP connectors: they add 100+ tools to
    // every call (measured: $1.70 → $0.18 for one plan step). Project CLAUDE.md loads unless
    // context.project_instructions is off.
    settingSources: settingSources(cfg),
    strictMcpConfig: !cfg.orchestrator.user_settings,
    settings: compactSettings(cfg),
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `yxu/${VERSION}` },
    pathToClaudeCodeExecutable: claudeExecutable(),
  };
}

interface QueryResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  costUsd: number;
  sessionId?: string;
  cancelled?: boolean;
  /** Pipeline workflows: the values of their declared outputs. */
  outputs?: Record<string, string>;
  context?: ContextUsage;
  compactions: CompactInfo[];
}

type DrainRender = Pick<OrchestratorRender, "assistantText" | "toolCall" | "textStart" | "textDelta" | "compacted">;

/** Ask Claude Code how full the context window is. Best effort: never blocks a run for long. */
async function readContextUsage(q: Query): Promise<ContextUsage | undefined> {
  if (typeof q.getContextUsage !== "function") return undefined;
  try {
    const u = (await Promise.race([
      q.getContextUsage({ detail: "summary" }),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000)),
    ])) as Awaited<ReturnType<Query["getContextUsage"]>> | undefined;
    if (!u) return undefined;
    return {
      tokens: u.totalTokens,
      max: u.maxTokens,
      percentage: u.percentage,
      autoCompact: u.isAutoCompactEnabled,
      threshold: u.autoCompactThreshold,
      categories: (u.categories ?? []).filter((c) => c.kind === "used" && c.tokens > 0).map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
    };
  } catch {
    return undefined;
  }
}

export async function drain(q: AsyncIterable<SDKMessage>, render?: DrainRender, signal?: AbortSignal): Promise<QueryResult> {
  const out: QueryResult = { ok: false, text: "", costUsd: 0, compactions: [] };
  try {
    for await (const msg of q) {
      if ("session_id" in msg && typeof msg.session_id === "string") out.sessionId ??= msg.session_id;
      if (msg.type === "system" && msg.subtype === "compact_boundary") {
        const m = msg.compact_metadata;
        const info: CompactInfo = { trigger: m.trigger, preTokens: m.pre_tokens, postTokens: m.post_tokens };
        out.compactions.push(info);
        render?.compacted?.(info);
      }
      if (render && msg.type === "stream_event" && msg.parent_tool_use_id === null) {
        const ev = msg.event;
        if (ev.type === "content_block_start" && ev.content_block.type === "text") render.textStart?.();
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") render.textDelta?.(ev.delta.text);
      }
      if (render && msg.type === "assistant" && msg.parent_tool_use_id === null) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) render.assistantText(block.text);
          if (block.type === "tool_use") render.toolCall(block.name, (block.input ?? {}) as Record<string, unknown>);
        }
      }
      if (msg.type === "result") {
        // The CLI is still alive here: ask how full the window is before the stream closes.
        if ("getContextUsage" in q) out.context = await readContextUsage(q as Query);
        out.costUsd = msg.total_cost_usd;
        out.ok = msg.subtype === "success" && !msg.is_error;
        out.text = msg.subtype === "success" ? msg.result : `orchestrator stopped: ${msg.subtype}`;
        if (msg.subtype === "success") out.structured = msg.structured_output;
      }
    }
  } catch (e) {
    if (!signal?.aborted) throw e;
  }
  if (signal?.aborted) {
    out.ok = false;
    out.cancelled = true;
    out.text ||= "cancelled";
  }
  return out;
}

/**
 * One structured call to the orchestrator model (used by pipeline plan/review steps).
 * It may read the code, then must answer in the given schema.
 */
export async function askOrchestrator<T extends z.ZodType>(opts: {
  cfg: Config;
  root: string;
  abort: AbortController;
  system: string;
  prompt: string;
  schema: T;
  render?: DrainRender;
}): Promise<{ value: z.infer<T>; costUsd: number }> {
  const q = query({
    prompt: opts.prompt,
    options: {
      ...baseOptions(opts.cfg, opts.root, opts.abort),
      allowedTools: READ_ONLY_TOOLS,
      systemPrompt: { type: "preset", preset: "claude_code", append: `${opts.system}\n\n${buildContextPrompt(opts.cfg, opts.root).text}` },
      outputFormat: { type: "json_schema", schema: jsonSchema(opts.schema) },
    },
  });
  const r = await drain(q, opts.render, opts.abort.signal);
  if (!r.ok) throw new Error(r.text || "orchestrator call failed");
  const parsed = opts.schema.safeParse(r.structured);
  if (!parsed.success) throw new Error(`orchestrator returned invalid output: ${parsed.error.message}`);
  return { value: parsed.data, costUsd: r.costUsd };
}

/** JSON Schema for structured output; Claude Code's validator wants draft-07 without a $schema key. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return rest;
}

export function sessionPath(root: string, runId: string) {
  return join(root, ".yxu", "sessions", `${runId}.json`);
}

/** Auto mode: Opus drives the whole run with the yxu tools. */
export async function runOrchestrator(opts: {
  goal: string;
  cfg: Config;
  workflow: Workflow;
  root: string;
  render: OrchestratorRender;
  abort: AbortController;
  /** Reuse a task session across turns (interactive UIs), so earlier task ids stay valid. */
  session?: Session;
  /** Continue an earlier orchestrator conversation (RunOutcome.sdkSessionId). */
  resume?: string;
}): Promise<RunOutcome> {
  const { cfg, workflow, root, render } = opts;
  const session = opts.session ?? new Session();
  const runId = `run-${newTaskId()}`;
  const ops = new TaskOps(cfg, root, session, {
    allowedAgents: workflow.allowed_agents,
    signal: opts.abort.signal,
    hooks: render.hooks,
  });

  const extra = buildContextPrompt(cfg, root);
  const q = query({
    prompt: opts.goal,
    options: {
      ...baseOptions(cfg, root, opts.abort),
      maxBudgetUsd: cfg.orchestrator.max_budget_usd,
      allowedTools: [...READ_ONLY_TOOLS, ...TOOL_NAMES],
      mcpServers: { [SERVER_NAME]: createYxuServer(ops) },
      systemPrompt: { type: "preset", preset: "claude_code", append: `${orchestratorPrompt(workflow, root)}\n\n${extra.text}` },
      resume: opts.resume,
      includePartialMessages: Boolean(render.textDelta),
    },
  });
  const r = await drain(q, render, opts.abort.signal);

  session.save(sessionPath(root, runId), {
    runId,
    goal: opts.goal,
    workflow,
    orchestrator: cfg.orchestrator,
    ok: r.ok,
    costUsd: r.costUsd,
    finalText: r.text,
  });
  const tips = session.tips();
  return {
    runId,
    ok: r.ok,
    finalText: r.text,
    costUsd: r.costUsd,
    session,
    headTaskId: tips.length === 1 ? tips[0]!.taskId : undefined,
    sdkSessionId: r.sessionId,
    cancelled: r.cancelled,
    context: r.context,
    contextFiles: extra.files,
  };
}

/**
 * Summarize an orchestrator conversation now (the same as /compact in Claude Code), so later
 * messages keep their memory in fewer tokens.
 */
export async function compactConversation(opts: {
  cfg: Config;
  root: string;
  sessionId: string;
  abort: AbortController;
  /** Extra instructions for this compaction, on top of compact.instructions. */
  instructions?: string;
  render?: DrainRender;
}): Promise<{ ok: boolean; error?: string; compaction?: CompactInfo; context?: ContextUsage; costUsd: number }> {
  const q = query({
    prompt: `/compact ${compactInstructions(opts.cfg, opts.instructions)}`,
    options: { ...baseOptions(opts.cfg, opts.root, opts.abort), resume: opts.sessionId },
  });
  const r = await drain(q, opts.render, opts.abort.signal);
  const compaction = r.compactions.at(-1);
  if (!compaction) return { ok: false, error: r.cancelled ? "cancelled" : r.text || "no compaction happened", costUsd: r.costUsd, context: r.context };
  return { ok: true, compaction, context: r.context, costUsd: r.costUsd };
}
