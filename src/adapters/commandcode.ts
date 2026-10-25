import { emptyUsage, type Adapter, type AgentEvent, type ParsedResult } from "../types.ts";
import { lastLine, ndjson } from "./ndjson.ts";

const PERMISSION: Record<string, string> = {
  yolo: "yolo",
  "accept-edits": "accept-edits",
  plan: "plan",
};

/**
 * Command Code (`cmd -p --output-format json`): a stream of
 * `{"type":"event","event":{...}}` lines and a final `{"type":"result",...}` line.
 */
export const commandcode: Adapter = {
  name: "commandcode",

  command(task, profile) {
    const argv = [
      "cmd",
      "-p",
      task.prompt,
      "--output-format",
      "json",
      "--trust",
      "--skip-onboarding",
      "--no-auto-update",
      "--no-session",
      "--permission-mode",
      PERMISSION[profile.permission ?? "accept-edits"]!,
      "--max-turns",
      String(profile.maxTurns ?? 60),
    ];
    if (profile.model) argv.push("--model", profile.model);
    return argv;
  },

  parse(stdout, stderr, exitCode) {
    const events: AgentEvent[] = [];
    let final: any;
    let runEnd: any;

    for (const line of ndjson(stdout)) {
      if (line.type === "result") {
        final = line;
        continue;
      }
      const ev = line.type === "event" ? line.event : undefined;
      if (!ev) continue;
      switch (ev.type) {
        case "run_start":
          events.push({ kind: "start", sessionId: ev.sessionId });
          break;
        case "run_error":
          events.push({ kind: "error", message: ev.error?.message ?? "unknown error" });
          break;
        case "run_end":
          runEnd = ev.result;
          break;
        default:
          // Tool/text event shapes not yet captured from a successful run.
          events.push({ kind: "raw", type: ev.type });
      }
    }

    const u = final?.usage ?? runEnd?.usage;
    const usage = u
      ? {
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          cacheReadTokens: u.cacheReadTokens ?? 0,
          cacheWriteTokens: u.cacheWriteTokens ?? 0,
        }
      : emptyUsage();

    const ok = exitCode === 0 && final?.subtype !== "error" && !final?.error;
    const result: ParsedResult = {
      ok,
      summary: final?.finalText ?? runEnd?.finalText ?? "",
      sessionId: final?.sessionId,
      usage,
      turns: runEnd?.turnCount,
    };
    if (!ok) result.error = final?.error ?? lastLine(stderr) ?? `exit code ${exitCode}`;
    return { events, result };
  },
};
