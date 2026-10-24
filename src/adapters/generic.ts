/**
 * Any agent CLI, described in config instead of code:
 *
 *   aider:
 *     cli: generic
 *     command: [aider, --yes-always, --no-auto-commits, --model, "{{model}}", --message, "{{task}}"]
 *     output: text                 # text | json (one object) | ndjson (one object per line)
 *     summary: last-paragraph      # or all, or an expression: result / last.result / lines.0.text
 *     success: exit-code           # or an expression: "!is_error", "last.type == 'done'"
 *     usage: { input: usage.input_tokens, output: usage.output_tokens, cost: total_cost_usd }
 *
 * json output is the scope for expressions; ndjson gives `lines` (all objects) and `last`.
 * Every expression also sees `exit_code`, `stdout` and `stderr`.
 */
import { evaluate, render, toText, type Scope } from "../expr.ts";
import { emptyUsage, type AgentEvent, type AgentProfile, type GenericSpec, type ParsedResult, type TaskSpec } from "../types.ts";

export function genericCommand(spec: GenericSpec, task: TaskSpec, profile: AgentProfile): string[] {
  const scope = { task: task.prompt, model: profile.model ?? "", cwd: task.cwd };
  const argv: string[] = [];
  for (let i = 0; i < spec.command.length; i++) {
    const part = spec.command[i]!;
    // "--model {{model}}" pairs disappear when no model is set.
    if (!profile.model && /\{\{\s*model\s*\}\}/.test(part)) {
      if (argv.length && argv.at(-1)!.startsWith("-") && part.trim().startsWith("{{")) argv.pop();
      continue;
    }
    argv.push(render(part, scope));
  }
  return argv;
}

function lastParagraph(text: string): string {
  const paras = text.trim().split(/\n\s*\n/);
  return (paras.at(-1) ?? "").trim();
}

function scopeFor(spec: GenericSpec, stdout: string, stderr: string, exitCode: number | null): { scope: Scope; error?: string } {
  const base = { exit_code: exitCode, stdout, stderr };
  if (spec.output === "json") {
    const text = stdout.trim();
    const start = text.indexOf("{");
    try {
      const obj = JSON.parse(start > 0 ? text.slice(start) : text);
      return { scope: { ...base, ...obj } };
    } catch {
      return { scope: base, error: "expected JSON on stdout" };
    }
  }
  if (spec.output === "ndjson") {
    const lines = stdout
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .filter((x) => x && typeof x === "object");
    return { scope: { ...base, lines, last: lines.at(-1) } };
  }
  return { scope: base };
}

export function genericParse(spec: GenericSpec, stdout: string, stderr: string, exitCode: number | null): { events: AgentEvent[]; result: ParsedResult } {
  const { scope, error: shapeError } = scopeFor(spec, stdout, stderr, exitCode);
  const expr = (src: string | undefined) => {
    if (!src) return undefined;
    try {
      return evaluate(src, scope);
    } catch {
      return undefined;
    }
  };
  let summary: string;
  if (spec.summary === "all") summary = stdout.trim();
  else if (spec.summary === "last-paragraph") summary = lastParagraph(stdout);
  else summary = toText(expr(spec.summary)).trim();
  const ok = spec.success === "exit-code" ? exitCode === 0 && !shapeError : Boolean(expr(spec.success)) && !shapeError;
  const usage = emptyUsage();
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
  usage.inputTokens = num(expr(spec.usage?.input));
  usage.outputTokens = num(expr(spec.usage?.output));
  const cost = expr(spec.usage?.cost);
  const lastErr = stderr.trim().split("\n").at(-1);
  return {
    events: [],
    result: {
      ok,
      summary,
      error: ok ? undefined : shapeError ?? (lastErr || `exit ${exitCode}`),
      usage,
      costUsd: cost === undefined ? undefined : num(cost),
    },
  };
}
