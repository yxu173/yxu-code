import { emptyUsage, type Adapter, type AgentEvent, type ParsedResult } from "../types.ts";
import { lastLine, ndjson } from "./ndjson.ts";

/**
 * OpenCode (`opencode run --format json`): one line per part —
 * step_start / tool_use / text / step_finish (with tokens + cost) / error.
 */
export const opencode: Adapter = {
  name: "opencode",

  command(task, profile) {
    const argv = ["opencode", "run", "--format", "json", "--dir", task.cwd];
    if (profile.model) argv.push("--model", profile.model);
    if (profile.agent) argv.push("--agent", profile.agent);
    else if (profile.permission === "plan") argv.push("--agent", "plan");
    if (profile.permission === "yolo") argv.push("--auto");
    argv.push(task.prompt);
    return argv;
  },

  resume(task, profile, sessionId) {
    const argv = opencode.command(task, profile);
    argv.splice(argv.length - 1, 0, "--session", sessionId);
    return argv;
  },

  parse(stdout, stderr, exitCode) {
    const events: AgentEvent[] = [];
    const usage = emptyUsage();
    let cost = 0;
    let steps = 0;
    let sessionId: string | undefined;
    let lastReason: string | undefined;
    const texts: string[] = [];
    const errors: string[] = [];

    for (const line of ndjson(stdout)) {
      const part = line.part ?? {};
      if (!sessionId && line.sessionID) {
        sessionId = line.sessionID;
        events.push({ kind: "start", sessionId });
      }
      switch (line.type) {
        case "tool_use": {
          const input = part.state?.input ?? {};
          events.push({
            kind: "tool",
            name: part.tool,
            status: part.state?.status,
            target: input.filePath ?? input.command ?? input.pattern,
          });
          break;
        }
        case "text":
          if (part.text) {
            texts.push(part.text);
            events.push({ kind: "text", text: part.text });
          }
          break;
        case "step_finish": {
          steps++;
          lastReason = part.reason;
          const t = part.tokens ?? {};
          usage.inputTokens += t.input ?? 0;
          usage.outputTokens += (t.output ?? 0) + (t.reasoning ?? 0);
          usage.cacheReadTokens += t.cache?.read ?? 0;
          usage.cacheWriteTokens += t.cache?.write ?? 0;
          cost += part.cost ?? 0;
          break;
        }
        case "error": {
          const msg = line.error?.data?.message ?? line.error?.message ?? JSON.stringify(line.error);
          errors.push(msg);
          events.push({ kind: "error", message: msg });
          break;
        }
        case "step_start":
          break;
        default:
          events.push({ kind: "raw", type: line.type });
      }
    }

    const ok = exitCode === 0 && errors.length === 0 && steps > 0;
    const result: ParsedResult = {
      ok,
      summary: texts.at(-1) ?? "",
      sessionId,
      usage,
      costUsd: cost,
      turns: steps,
    };
    if (!ok) {
      result.error =
        errors.at(-1) ?? lastLine(stderr) ?? (steps === 0 ? "no output from opencode" : `exit code ${exitCode}`);
    } else if (lastReason && lastReason !== "stop") {
      result.summary ||= `(stopped: ${lastReason})`;
    }
    return { events, result };
  },
};
