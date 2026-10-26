import { emptyUsage, type Adapter, type AgentEvent, type ParsedResult } from "../types.ts";
import { lastLine, ndjson } from "./ndjson.ts";

const PERMISSION: Record<string, string> = {
  yolo: "bypassPermissions",
  "accept-edits": "acceptEdits",
  plan: "plan",
};

/**
 * Claude Code as a subagent (`claude -p --output-format stream-json --verbose`): one line per
 * message (so tool calls show live), ending with a result line. A single result object
 * (`--output-format json`, older runs) is read too.
 * The orchestrator itself uses the Agent SDK; this adapter is for Claude workers.
 */
export const claude: Adapter = {
  name: "claude",

  command(task, profile) {
    const argv = [
      "claude",
      "-p",
      task.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      PERMISSION[profile.permission ?? "accept-edits"]!,
      "--max-turns",
      String(profile.maxTurns ?? 60),
      // Skip the user's global plugins/hooks/MCP connectors: large token overhead per call.
      "--setting-sources",
      "project",
      "--strict-mcp-config",
    ];
    if (profile.model) argv.push("--model", profile.model);
    return argv;
  },

  resume(task, profile, sessionId) {
    return [...claude.command(task, profile), "--resume", sessionId];
  },

  parse(stdout, stderr, exitCode) {
    let r: any;
    const events: AgentEvent[] = [];
    try {
      r = JSON.parse(stdout.trim());
    } catch {
      // stream-json: a line per message, the result last
      for (const line of ndjson(stdout)) {
        if (line.type === "system" && line.subtype === "init" && line.session_id) events.push({ kind: "start", sessionId: line.session_id });
        if (line.type === "assistant" && !line.parent_tool_use_id) {
          for (const b of line.message?.content ?? []) {
            if (b.type === "tool_use") events.push({ kind: "tool", name: b.name, status: "started", target: b.input?.file_path ?? b.input?.command ?? b.input?.pattern ?? b.input?.path });
            if (b.type === "text" && b.text?.trim()) events.push({ kind: "text", text: b.text });
          }
        }
        if (line.type === "result") r = line;
      }
    }
    const u = r?.usage;
    const usage = u
      ? {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        }
      : emptyUsage();

    const ok = exitCode === 0 && r?.type === "result" && !r.is_error;
    const result: ParsedResult = {
      ok,
      summary: typeof r?.result === "string" ? r.result : "",
      sessionId: r?.session_id,
      usage,
      costUsd: r?.total_cost_usd,
      turns: r?.num_turns,
    };
    if (!ok) result.error = (r?.is_error && r.result) || lastLine(stderr) || `exit code ${exitCode}`;
    if (r?.session_id && !events.some((e) => e.kind === "start")) events.unshift({ kind: "start", sessionId: r.session_id });
    return { events, result };
  },
};
