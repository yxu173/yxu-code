import { getSessionInfo, query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeExecutable, VERSION } from "../platform.ts";
import { ORCHESTRATOR_BASE, prompt } from "../prompts.ts";
import type { Asker } from "../permissions.ts";
import { join } from "node:path";
import { z } from "zod";
import type { Config, Workflow } from "../config.ts";
import { buildContextPrompt, worthCompacting, compactInstructions, compactSettings, settingSources, type ContextUsage, type IncludedFile } from "../context.ts";
import { Session, TaskOps, type OpsHooks } from "../ops.ts";
import { newTaskId } from "../runner.ts";
import { createYxuServer, SERVER_NAME, TOOL_NAMES } from "./tools.ts";
import { buildRepoMap } from "../repomap.ts";
import { recapPreamble, type TurnRecord } from "../conversation.ts";
import { hasTranscript, transcriptStore } from "../transcripts.ts";

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
  /** The conversation to resume was gone, so it was rebuilt from yxu's record of its turns. */
  memoryRebuilt?: boolean;
  /**
   * A summary started during the run and not used by it: resolves with the compacted fork.
   * `tail` is what happened in the run after the fork (see Conversation.adopt).
   */
  backgroundSummary?: { done: Promise<CompactResult | undefined>; tail: string };
  /** Files from context.include that were (or could not be) added. */
  contextFiles?: IncludedFile[];
}

export interface OrchestratorRender {
  assistantText(text: string): void;
  toolCall(name: string, input: Record<string, unknown>): void;
  hooks: OpsHooks;
  /** Ask the user whether an agent may use a tool (ACP agents). Without it, such tools are refused. */
  ask?: Asker;
  /** Pipeline progress. */
  step?(info: { id: string; type: string; index: number; total: number; note?: string }): void;
  /** Streaming: a new assistant text block begins / receives a chunk. assistantText() finalizes it. */
  textStart?(): void;
  textDelta?(chunk: string): void;
  /** The orchestrator conversation was summarized (automatically or on request). */
  compacted?(info: CompactInfo): void;
}

export interface CompactInfo {
  /** background: yxu compacted a fork while the orchestrator waited, then handed over to it. */
  trigger: "auto" | "manual" | "background";
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

export async function drain(
  q: AsyncIterable<SDKMessage>,
  render?: DrainRender,
  signal?: AbortSignal,
  opts: { onMessage?: (msg: SDKMessage) => void; stopping?: () => boolean } = {},
): Promise<QueryResult> {
  const out: QueryResult = { ok: false, text: "", costUsd: 0, compactions: [] };
  try {
    for await (const msg of q) {
      opts.onMessage?.(msg);
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
    // An interrupt we asked for (a hand-over) ends the stream with an error result.
    if (!signal?.aborted && !opts.stopping?.()) throw e;
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

/** Whether a conversation can be resumed: yxu has a copy, or Claude Code's history does. */
export async function conversationExists(sessionId: string, root: string): Promise<boolean> {
  if (hasTranscript(sessionId)) return true;
  try {
    // Claude Code's lookup can be slow (it scans its history); if it doesn't answer in time,
    // assume the conversation is there rather than drop its memory.
    const info = await Promise.race([getSessionInfo(sessionId, { dir: root }).then((i) => Boolean(i)), new Promise<boolean>((r) => setTimeout(() => r(true), 10_000).unref?.())]);
    return info;
  } catch {
    return false;
  }
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
  /** Text before the goal (what happened since a summary that `resume` points at). */
  preamble?: string;
  /** The conversation so far as yxu recorded it: used if `resume` can't be found anywhere. */
  history?: TurnRecord[];
}): Promise<RunOutcome> {
  const { cfg, workflow, root, render } = opts;
  if ((cfg.orchestrator.provider ?? "claude") !== "claude") {
    const name = (workflow as { name?: string }).name ?? "default";
    throw new Error(`workflow "${name}" is an auto workflow, which needs orchestrator.provider: claude (it is "${cfg.orchestrator.provider}"). Use a pipeline workflow (for example \`feature\`), or set orchestrator.provider back to claude.`);
  }
  const session = opts.session ?? new Session();
  const runId = `run-${newTaskId()}`;
  const ops = new TaskOps(cfg, root, session, {
    allowedAgents: workflow.allowed_agents,
    signal: opts.abort.signal,
    hooks: render.hooks,
    ask: render.ask,
  });

  if (cfg.context.repo_map) await buildRepoMap(root).catch(() => undefined); // incremental: only changed files are read
  const extra = buildContextPrompt(cfg, root);
  const mid = new MidRunCompactor(cfg, root, opts.abort.signal);
  let prompt = `${opts.preamble ?? ""}${opts.goal}`;
  let resume = opts.resume;
  // Neither yxu's copy nor Claude Code's history has the conversation: start again from yxu's record.
  let rebuilt = false;
  if (resume && !(await conversationExists(resume, root))) {
    resume = undefined;
    prompt = `${recapPreamble(opts.history ?? [])}${opts.goal}`;
    rebuilt = true;
  }
  let spent = 0;
  let r: QueryResult;
  // One query, or several when a background summary takes over mid-run (see MidRunCompactor).
  for (;;) {
    const budget = cfg.orchestrator.max_budget_usd;
    const q = query({
      prompt,
      options: {
        ...baseOptions(cfg, root, opts.abort),
        maxBudgetUsd: budget === undefined ? undefined : Math.max(0.01, budget - spent - mid.costUsd),
        allowedTools: [...READ_ONLY_TOOLS, ...TOOL_NAMES],
        mcpServers: { [SERVER_NAME]: createYxuServer(ops, mid) },
        sessionStore: transcriptStore(),
        systemPrompt: { type: "preset", preset: "claude_code", append: `${orchestratorPrompt(workflow, root)}\n\n${extra.text}` },
        resume,
        includePartialMessages: Boolean(render.textDelta),
      },
    });
    mid.attach(q);
    r = await drain(q, render, opts.abort.signal, { onMessage: (m) => mid.observe(m), stopping: () => Boolean(mid.handoff) });
    spent += r.costUsd;
    const h = mid.handoff;
    if (!h || opts.abort.signal.aborted) break;
    render.compacted?.(h.compaction);
    prompt = h.prompt;
    resume = h.sessionId;
    mid.reset();
  }
  r.costUsd = spent + mid.costUsd;

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
    backgroundSummary: opts.abort.signal.aborted ? (mid.cancel(), undefined) : mid.leftover(),
    ...(rebuilt ? { memoryRebuilt: true } : {}),
  };
}

/**
 * Compaction during a run, without pausing it. Claude Code compacts when the window fills, and
 * the orchestrator stops until that is done. Instead, while the orchestrator waits on a yxu tool
 * (a subagent usually takes minutes) and the window is past compact.background_at, this compacts
 * a fork of the conversation in the background and records what happens after the fork. When the
 * summary is ready, at the end of the next yxu tool call, it hands over: the current query is
 * interrupted, and the run continues in the compacted fork, told the tool's result and anything
 * else since the fork. Hand-over only happens when the orchestrator's last message made exactly
 * that one call, so no result is lost. A summary not used by the end of the run is handed to the
 * caller (RunOutcome.backgroundSummary) for the next turn.
 */
export class MidRunCompactor {
  private q?: Query;
  private sessionId?: string;
  private job?: { abort: AbortController; done: Promise<CompactResult | undefined>; result?: CompactResult; settled: boolean };
  private since: string[] = [];
  /** The orchestrator's latest message called exactly one tool, a yxu one. */
  private singleYxuCall = false;
  handoff?: { sessionId: string; prompt: string; compaction: CompactInfo };
  /** What background summaries cost (part of the run's orchestrator cost). */
  costUsd = 0;

  constructor(
    private cfg: Config,
    private root: string,
    private signal: AbortSignal,
  ) {}

  attach(q: Query) {
    this.q = q;
  }

  /** Every message of the stream: session id, the last call, and what happens after a fork. */
  observe(msg: SDKMessage) {
    if ("session_id" in msg && typeof msg.session_id === "string") this.sessionId = msg.session_id;
    if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
      const calls = msg.message.content.filter((b) => b.type === "tool_use");
      this.singleYxuCall = calls.length === 1 && calls[0]!.type === "tool_use" && calls[0]!.name.startsWith(`mcp__${SERVER_NAME}__`);
      if (!this.job) return;
      for (const b of msg.message.content) {
        if (b.type === "text" && b.text.trim()) this.since.push(`You wrote: ${clipText(b.text, 3000)}`);
        if (b.type === "tool_use") this.since.push(`You called ${b.name.replace(`mcp__${SERVER_NAME}__`, "")}(${clipText(JSON.stringify(b.input ?? {}), 1500)})`);
      }
    }
    if (this.job && msg.type === "user" && msg.parent_tool_use_id === null && Array.isArray(msg.message.content)) {
      for (const b of msg.message.content as { type: string; content?: unknown }[]) {
        if (b.type === "tool_result") this.since.push(`It returned: ${clipText(toolResultText(b.content), 3000)}`);
      }
    }
  }

  /** A long yxu tool started: if the window is filling, start summarizing a fork. Never blocks the tool. */
  toolStart() {
    const k = this.cfg.compact;
    if (!k.auto || !k.background || this.job || !this.q || !this.sessionId || this.signal.aborted) return;
    const q = this.q;
    const from = this.sessionId;
    void readContextUsage(q).then((u) => {
      if (!worthCompacting(u, k) || this.job || this.q !== q || this.signal.aborted) return;
      const abort = new AbortController();
      const stop = () => abort.abort();
      this.signal.addEventListener("abort", stop, { once: true });
      this.since = [];
      const job: NonNullable<MidRunCompactor["job"]> = { abort, settled: false, done: Promise.resolve(undefined) };
      job.done = compactConversation({ cfg: this.cfg, root: this.root, sessionId: from, abort, fork: true })
        .catch((e: Error) => ({ ok: false, error: e.message, costUsd: 0 }) as CompactResult)
        .then((res) => {
          this.costUsd += res.costUsd;
          job.result = res;
          job.settled = true;
          this.signal.removeEventListener("abort", stop);
          return res.ok && res.sessionId ? res : undefined;
        });
      this.job = job;
    });
  }

  /** A yxu tool finished with `text`: hand over now if the summary is ready. */
  toolEnd(tool: string, text: string) {
    const j = this.job;
    if (!j?.settled || this.handoff || !this.q || !this.singleYxuCall || this.signal.aborted) return;
    const res = j.result;
    if (!res?.ok || !res.sessionId || !res.compaction) {
      this.job = undefined; // failed: Claude Code's own compaction remains the fallback
      return;
    }
    const since = this.since.length ? `Before it returned:\n${this.since.join("\n")}\n\n` : "";
    this.handoff = {
      sessionId: res.sessionId,
      compaction: { ...res.compaction, trigger: "background" },
      prompt: `[yxu] This conversation was summarized in the background while you waited on a ${tool} call, and continues here. ${since}Your ${tool} call returned:\n${text}\n\n[yxu] Continue the task from here.`,
    };
    void this.q.interrupt().catch(() => {});
  }

  /** After a hand-over: the next query starts clean. */
  reset() {
    this.handoff = undefined;
    this.job = undefined;
    this.since = [];
    this.singleYxuCall = false;
  }

  cancel() {
    this.job?.abort.abort();
    this.job = undefined;
  }

  /** A summary the run started but didn't use: for the next turn, with what happened after the fork. */
  leftover(): RunOutcome["backgroundSummary"] {
    if (!this.job) return undefined;
    return { done: this.job.done, tail: this.since.join("\n") };
  }
}

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return "";
}

/**
 * Summarize an orchestrator conversation now (the same as /compact in Claude Code), so later
 * messages keep their memory in fewer tokens.
 */
export type CompactResult = { ok: boolean; error?: string; compaction?: CompactInfo; context?: ContextUsage; costUsd: number; sessionId?: string };

export async function compactConversation(opts: {
  cfg: Config;
  root: string;
  sessionId: string;
  abort: AbortController;
  /** Extra instructions for this compaction, on top of compact.instructions. */
  instructions?: string;
  render?: DrainRender;
  /** Compact a copy (a forked session) and leave the original as it is: for background compaction. */
  fork?: boolean;
}): Promise<CompactResult> {
  const q = query({
    prompt: `/compact ${compactInstructions(opts.cfg, opts.instructions)}`,
    options: { ...baseOptions(opts.cfg, opts.root, opts.abort), sessionStore: transcriptStore(), resume: opts.sessionId, ...(opts.fork ? { forkSession: true } : {}) },
  });
  const r = await drain(q, opts.render, opts.abort.signal);
  const compaction = r.compactions.at(-1);
  if (!compaction) return { ok: false, error: r.cancelled ? "cancelled" : r.text || "no compaction happened", costUsd: r.costUsd, context: r.context };
  // A fork has its own session id: continue from it.
  return { ok: true, compaction, context: r.context, costUsd: r.costUsd, sessionId: opts.fork ? r.sessionId : opts.sessionId };
}
