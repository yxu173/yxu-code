import { emptyUsage, type Adapter, type ParsedResult } from "../types.ts";
import { lastLine } from "./ndjson.ts";

const PERMISSION: Record<string, string> = {
  yolo: "bypassPermissions",
  "accept-edits": "acceptEdits",
  plan: "plan",
};

/**
 * Claude Code as a subagent (`claude -p --output-format json`): a single result object.
 * The orchestrator itself will use the Agent SDK; this adapter is for Claude workers.
 */
export const claude: Adapter = {
  name: "claude",

  command(task, profile) {
    const argv = [
      "claude",
      "-p",
      task.prompt,
      "--output-format",
      "json",
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

  parse(stdout, stderr, exitCode) {
    let r: any;
    try {
      r = JSON.parse(stdout.trim());
    } catch {
      r = undefined;
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
    const events = r?.session_id ? [{ kind: "start" as const, sessionId: r.session_id }] : [];
    return { events, result };
  },
};
