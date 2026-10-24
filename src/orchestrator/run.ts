import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { z } from "zod";
import type { Config, Workflow } from "../config.ts";
import { buildContextPrompt, compactInstructions, compactSettings, settingSources, type ContextUsage, type IncludedFile } from "../context.ts";
import { Session, TaskOps, type OpsHooks } from "../ops.ts";
import { newTaskId } from "../runner.ts";
import { createYxuServer, SERVER_NAME, TOOL_NAMES } from "./tools.ts";

/** Read-only built-ins so the orchestrator can study the code but never edit it. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

export function orchestratorPrompt(workflow: Workflow): string {
  return `
# You are the yxu orchestrator

You lead a team of local coding subagents. You plan, delegate, and review. You cannot edit
files yourself; you only have read-only tools plus the yxu tools:

- list_agents: see the available subagents.
- delegate(agent, task, build_on?): run one task with a subagent in an isolated git worktree.
- delegate_parallel(tasks): run several independent tasks at once, each in its own worktree.
- combine(task_ids, resolver?): merge several tasks into one new task (conflicts resolved by an agent).
- verify(task_id, command?): run the test/check command in a task's worktree.
- get_diff(task_id, cumulative?): see a task's full diff.
- discard(task_id): throw away failed, rejected, or superseded work.

## How to work
1. Read enough of the codebase to plan. Split the goal into small, concrete tasks.
2. Write every task so it stands alone: the subagent cannot see this conversation. Name the
   files, the expected behavior, and how to verify it (e.g. which test command to run).
3. Run independent tasks (different files, no ordering) together with delegate_parallel, then
   combine the successful ones into a single task. Run dependent tasks with delegate and
   build_on set to the task they depend on; without build_on a task starts from the user's
   original HEAD and won't see earlier work. Keep parallel tasks from editing the same files
   where you can, to avoid conflicts.
4. Review each diff critically against the goal. If it is wrong or incomplete, delegate a
   fix with build_on set to that task (say exactly what to change), or discard it and retry,
   possibly with a stronger agent.
5. Run verify on the final task. If it fails, delegate a fix (build_on the final task) with the
   failure output, then verify again.
6. Subagents can fail (rate limits, auth, timeouts). On an infrastructure failure, switch to
   another agent instead of retrying the same one.

yxu commits each task's changes to its own branch (yxu/<task_id>) automatically. The user's
checkout is never touched until they run \`yxu apply\`.

## Rules
- Never claim the changes are applied. The user reviews and applies them with \`yxu apply\`.
- Discard work you rejected, so only good work is left pending. After combining, you may
  discard the parallel parents; the combined task contains their commits.
- Aim to leave exactly ONE task for the user to apply (combine if needed).
- Finish with a short report: what was done, verification results, the task_id to apply, and
  any caveats or follow-ups.
${workflow.instructions ? `\n## Workflow instructions (from yxu.yaml)\n${workflow.instructions}` : ""}`;
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
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "yxu/0.3.0" },
  };
}

interface QueryResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  costUsd: number;
  sessionId?: string;
  cancelled?: boolean;
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
      systemPrompt: { type: "preset", preset: "claude_code", append: `${orchestratorPrompt(workflow)}\n\n${extra.text}` },
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
