/**
 * Agent Client Protocol (https://agentclientprotocol.com) client: runs one task with any ACP
 * agent (`opencode acp`, `gemini --experimental-acp`, Claude Code via claude-code-acp, …).
 * JSON-RPC 2.0, one message per line on stdio. yxu advertises no file-system or terminal
 * capabilities, so agents use their own tools; their permission requests go through
 * permissions.ts, and their tool calls stream out as events while they work.
 */
import { killGroup, spawnDuplex, VERSION } from "./platform.ts";
import { alwaysRule, policy, type Asker, type PermissionRequest } from "./permissions.ts";
import { emptyUsage, type AgentEvent, type AgentProfile, type ParsedResult } from "./types.ts";

export interface AcpRun {
  agent: string;
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  prompt: string;
  profile: AgentProfile;
  signal?: AbortSignal;
  timeoutMs: number;
  onEvent?: (e: AgentEvent) => void;
  ask?: Asker;
  /** "Always" answers, shared across tasks in a session. */
  always?: Set<string>;
  onPid?: (pid: number) => void;
}

export interface AcpOutcome {
  result: ParsedResult;
  events: AgentEvent[];
  /** Every message in and out, one per line (for logs and `yxu agent capture`). */
  transcript: string;
  stderr: string;
  exitCode: number | null;
}

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string; data?: unknown } };

class AcpError extends Error {}

export async function runAcp(o: AcpRun): Promise<AcpOutcome> {
  const proc = spawnDuplex(o.argv, { cwd: o.cwd, env: o.env, detached: true });
  o.onPid?.(proc.pid);
  const transcript: string[] = [];
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => {
    events.push(e);
    o.onEvent?.(e);
  };
  let nextId = 0;
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const send = (m: Msg) => {
    const line = JSON.stringify(m);
    transcript.push(`> ${line}`);
    proc.write(`${line}\n`);
  };
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });

  // Session state built from notifications.
  const messages = new Map<string, string>();
  let lastMessage = "";
  let costUsd: number | undefined;
  const tools = new Map<string, { title: string; kind: string; target?: string }>();
  const reported = new Set<string>();

  const onUpdate = (u: any) => {
    switch (u?.sessionUpdate) {
      case "agent_message_chunk": {
        const text = u.content?.type === "text" ? String(u.content.text ?? "") : "";
        const key = u.messageId ?? "_";
        messages.set(key, (messages.get(key) ?? "") + text);
        lastMessage = key;
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const prev = tools.get(u.toolCallId) ?? { title: "", kind: "other" };
        const cmd = Array.isArray(u.rawInput?.command) ? u.rawInput.command.join(" ") : u.rawInput?.command;
        const target = cmd ?? u.rawInput?.filePath ?? u.locations?.[0]?.path ?? u.rawInput?.pattern ?? prev.target;
        const t = { title: u.title ?? prev.title, kind: u.kind ?? prev.kind, target };
        tools.set(u.toolCallId, t);
        // One event when a call gets going, one when it ends.
        const phase = u.status === "completed" || u.status === "failed" ? u.status : u.status === "in_progress" ? "started" : undefined;
        const key = `${u.toolCallId}:${phase}`;
        if (!phase || reported.has(key)) break;
        reported.add(key);
        emit({ kind: "tool", id: u.toolCallId, name: t.kind === "other" ? t.title : t.kind, status: phase, target: typeof target === "string" ? target : undefined });
        break;
      }
      case "usage_update":
        if (typeof u.cost?.amount === "number") costUsd = u.cost.amount;
        break;
      case "plan":
        emit({ kind: "raw", type: `plan: ${(u.entries ?? []).map((e: any) => e.content).join("; ").slice(0, 200)}` });
        break;
    }
  };

  const onPermission = async (params: any): Promise<unknown> => {
    const call = params?.toolCall ?? {};
    const known = tools.get(call.toolCallId);
    const raw = call.rawInput ?? {};
    const req: PermissionRequest = {
      agent: o.agent,
      kind: call.kind ?? known?.kind ?? "other",
      title: call.title ?? known?.title ?? "tool",
      command: typeof raw.command === "string" ? raw.command : Array.isArray(raw.command) ? raw.command.join(" ") : undefined,
      paths: (call.locations ?? []).map((l: any) => l.path).filter(Boolean),
    };
    const options: { optionId: string; kind: string }[] = params?.options ?? [];
    const pick = (...kinds: string[]) => kinds.map((k) => options.find((x) => x.kind === k)).find(Boolean);
    let decision = policy(o.profile, req, o.always);
    let always = false;
    if (decision === "ask") {
      const answer = o.ask ? await o.ask(req) : "deny";
      decision = answer === "deny" ? "deny" : "allow";
      always = answer === "always";
      if (always) o.always?.add(alwaysRule(req));
    }
    emit({ kind: "permission", tool: `${req.kind}: ${req.command ?? req.title}`, decision: decision === "allow" ? (always ? "allowed for the session" : "allowed") : o.ask ? "denied" : "denied (no one to ask)" });
    const opt = decision === "allow" ? pick(always ? "allow_always" : "allow_once", "allow_once", "allow_always") : pick("reject_once", "reject_always");
    return opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } };
  };

  // Reader: responses resolve requests; agent requests get answers; notifications update state.
  let closed = false;
  const reader = (async () => {
    for await (const line of proc.lines()) {
      if (!line.trim()) continue;
      transcript.push(`< ${line}`);
      let m: Msg;
      try {
        m = JSON.parse(line);
      } catch {
        continue; // agents sometimes log to stdout
      }
      if (m.method && m.id !== undefined) {
        const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
        if (m.method === "session/request_permission") {
          onPermission(m.params).then(reply, () => reply({ outcome: { outcome: "cancelled" } }));
        } else {
          send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `yxu does not provide ${m.method}` } });
        }
      } else if (m.method) {
        if (m.method === "session/update") onUpdate(m.params?.update);
      } else if (typeof m.id === "number" && waiting.has(m.id)) {
        const w = waiting.get(m.id)!;
        waiting.delete(m.id);
        if (m.error) w.reject(new AcpError(m.error.message + (m.error.data ? ` (${JSON.stringify(m.error.data).slice(0, 200)})` : "")));
        else w.resolve(m.result);
      }
    }
    closed = true;
    for (const w of waiting.values()) w.reject(new AcpError("the agent exited"));
    waiting.clear();
  })();

  let sessionId: string | undefined;
  let stop: string | undefined;
  const finish = (reason: string) => {
    stop ??= reason;
    if (sessionId && !closed) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    // Give the agent a moment to wind down, then stop it.
    setTimeout(() => killGroup(proc.pid, "SIGTERM"), 3000).unref();
    setTimeout(() => killGroup(proc.pid, "SIGKILL"), 8000).unref();
  };
  const timer = setTimeout(() => finish("timeout"), o.timeoutMs);
  const onAbort = () => finish("cancelled");
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener("abort", onAbort, { once: true });

  const result: ParsedResult = { ok: false, summary: "", usage: emptyUsage() };
  try {
    const init = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "yxu", version: VERSION },
    });
    let session: any;
    try {
      session = await request("session/new", { cwd: o.cwd, mcpServers: [] });
    } catch (e) {
      const how = (init?.authMethods ?? []).map((m: any) => m.description ?? m.name).filter(Boolean).join("; ");
      throw new AcpError(`${(e as Error).message}${how ? ` — log in first: ${how}` : ""}`);
    }
    sessionId = session.sessionId;
    emit({ kind: "start", sessionId });
    if (o.profile.model) await selectModel(request, session, o.profile.model, emit);
    if (o.profile.permission === "plan") await selectPlanMode(request, session);
    const res = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: o.prompt }] });
    const u = res?.usage ?? {};
    result.usage = {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cachedReadTokens ?? 0,
      cacheWriteTokens: u.cachedWriteTokens ?? 0,
    };
    result.summary = (messages.get(lastMessage) ?? "").trim();
    result.ok = res?.stopReason === "end_turn" && !stop;
    if (!result.ok) result.error = stop ?? `the agent stopped: ${res?.stopReason ?? "unknown reason"}`;
  } catch (e) {
    result.error = stop ?? (e as Error).message;
    result.summary = (messages.get(lastMessage) ?? "").trim();
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    killGroup(proc.pid, "SIGTERM");
    setTimeout(() => killGroup(proc.pid, "SIGKILL"), 3000).unref();
  }
  result.costUsd = costUsd;
  result.sessionId = sessionId;
  const exitCode = await Promise.race([proc.exited, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
  await Promise.race([reader, new Promise((r) => setTimeout(r, 500))]);
  const stderr = await Promise.race([proc.stderr, new Promise<string>((r) => setTimeout(() => r(""), 500))]);
  if (!result.ok && !result.error) result.error = stderr.trim().split("\n").at(-1) || "the agent failed";
  if (result.error && closed && !stop && stderr.trim()) result.error = `${result.error}: ${stderr.trim().split("\n").at(-1)}`;
  return { result, events, transcript: transcript.join("\n"), stderr, exitCode };
}

type Request = (method: string, params: unknown) => Promise<any>;

/** Pick the model through session config options (stable ACP) or session/set_model. */
async function selectModel(request: Request, session: any, model: string, emit: (e: AgentEvent) => void) {
  const opt = (session.configOptions ?? []).find((c: any) => c.category === "model" || c.id === "model");
  if (opt) {
    const values: string[] = (opt.options ?? []).map((x: any) => x.value);
    if (values.length && !values.includes(model)) throw new AcpError(`model "${model}" is not offered by this agent (try \`yxu models <agent>\`)`);
    await request("session/set_config_option", { sessionId: session.sessionId, configId: opt.id, value: model });
    return;
  }
  if (session.models) {
    await request("session/set_model", { sessionId: session.sessionId, modelId: model });
    return;
  }
  emit({ kind: "error", message: `this agent does not let clients choose a model; "${model}" was ignored` });
}

/** Use the agent's own read-only mode when it has one (yxu also refuses edits in plan). */
async function selectPlanMode(request: Request, session: any) {
  const opt = (session.configOptions ?? []).find((c: any) => c.category === "mode" || c.id === "mode");
  const value = opt?.options?.map((x: any) => x.value).find((v: string) => /plan|read/i.test(v));
  if (opt && value) return request("session/set_config_option", { sessionId: session.sessionId, configId: opt.id, value }).catch(() => {});
  const mode = session.modes?.availableModes?.map((m: any) => m.id).find((id: string) => /plan|read/i.test(id));
  if (mode) return request("session/set_mode", { sessionId: session.sessionId, modeId: mode }).catch(() => {});
}

/** The models an ACP agent offers (it is started, asked, and stopped). */
export async function acpModels(argv: string[], cwd: string, env: Record<string, string | undefined>): Promise<{ id: string; name: string }[]> {
  const proc = spawnDuplex(argv, { cwd, env, detached: true });
  let id = 0;
  const pending = new Map<number, (m: Msg) => void>();
  const ask = (method: string, params: unknown) =>
    new Promise<Msg>((resolve) => {
      pending.set(++id, resolve);
      proc.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  (async () => {
    for await (const line of proc.lines()) {
      try {
        const m: Msg = JSON.parse(line);
        if (typeof m.id === "number" && !m.method) pending.get(m.id)?.(m);
      } catch {
        // not JSON
      }
    }
  })();
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("the agent did not answer within 20s")), 20_000));
  try {
    return await Promise.race([
      (async () => {
        const init = await ask("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
        if (init.error) throw new Error(init.error.message);
        const s = await ask("session/new", { cwd, mcpServers: [] });
        if (s.error) throw new Error(s.error.message);
        const opt = (s.result?.configOptions ?? []).find((c: any) => c.category === "model" || c.id === "model");
        if (opt) return (opt.options ?? []).map((x: any) => ({ id: String(x.value), name: String(x.name ?? x.value) }));
        const models = s.result?.models?.availableModels ?? [];
        return models.map((m: any) => ({ id: String(m.modelId), name: String(m.name ?? m.modelId) }));
      })(),
      timeout,
    ]);
  } finally {
    killGroup(proc.pid, "SIGKILL");
  }
}
