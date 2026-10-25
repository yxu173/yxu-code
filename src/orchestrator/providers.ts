/**
 * Who answers a pipeline's plan and review steps (`orchestrator.provider`). Each step is one
 * structured question: instructions, the material, and a JSON Schema for the answer.
 *
 *   claude   Claude Code through the Agent SDK (default; also the only one for auto workflows)
 *   agent    one of your agents (orchestrator.agent), read-only in its own worktree, answering
 *            with a JSON block. No Claude account needed.
 *   <name>   an orchestrator added by a plugin (plugin-api.ts)
 */
import { z } from "zod";
import { toProfile } from "../config.ts";
import { branchFor, removeWorktree } from "../git.ts";
import { runTask } from "../runner.ts";
import { askOrchestrator, jsonSchema } from "./run.ts";

export type AskOptions<T extends z.ZodType> = Parameters<typeof askOrchestrator<T>>[0] & {
  /** The task whose result is being judged (review steps). */
  head?: string;
};
export type AskFn = <T extends z.ZodType>(opts: AskOptions<T>) => Promise<{ value: z.infer<T>; costUsd: number }>;

/** Route one structured question to the configured provider. */
export const askProvider: AskFn = async (opts) => {
  const provider = opts.cfg.orchestrator.provider ?? "claude";
  if (provider === "claude") return askOrchestrator(opts);
  if (provider === "agent") return askAgent(opts);
  return askPlugin(provider, opts);
};

async function askPlugin<T extends z.ZodType>(name: string, opts: AskOptions<T>): Promise<{ value: z.infer<T>; costUsd: number }> {
  const found = opts.cfg.plugins?.orchestrators.get(name);
  if (!found) throw new Error(`orchestrator "${name}" is not loaded (see \`yxu plugins\`)`);
  const r = await found.orchestrator.ask({ system: opts.system, prompt: opts.prompt, schema: jsonSchema(opts.schema), signal: opts.abort.signal, root: opts.root });
  const parsed = opts.schema.safeParse(r?.value);
  if (!parsed.success) throw new Error(`orchestrator ${name} (plugin ${found.plugin}) returned an answer that doesn't match the schema: ${parsed.error.message}`);
  return { value: parsed.data, costUsd: r.costUsd ?? 0 };
}

/** One of the user's agents answers: read-only, in a worktree at the work so far, with a JSON block. */
async function askAgent<T extends z.ZodType>(opts: AskOptions<T>): Promise<{ value: z.infer<T>; costUsd: number }> {
  const name = opts.cfg.orchestrator.agent!;
  const def = opts.cfg.agents[name];
  if (!def) throw new Error(`orchestrator.agent "${name}" is not an agent`);
  const profile = { ...toProfile(def), permission: "plan" as const };
  const schema = JSON.stringify(jsonSchema(opts.schema), null, 2);
  let prompt = `You are answering for the yxu orchestrator, not writing code. Do not edit, create or delete any files, and do not run commands that change anything.

${opts.system}
${opts.head ? "\nThe code in the current directory includes the change being reviewed.\n" : ""}
${opts.prompt}

Read the code as needed, then answer with ONE JSON object matching this JSON Schema, in a \`\`\`json code block, as the last thing in your reply:
${schema}`;
  let cost = 0;
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (opts.abort.signal.aborted) throw new Error("cancelled");
    opts.render?.assistantText?.(`asking ${name} (orchestrator)${attempt > 1 ? " again: the first answer was not valid JSON for the schema" : ""}…`);
    const r = await runTask({
      agentName: name,
      profile,
      prompt,
      title: "orchestrator question",
      cwd: opts.root,
      baseRef: opts.head ? branchFor(opts.head) : undefined,
      signal: opts.abort.signal,
    });
    cost += r.costUsd ?? 0;
    removeWorktree(opts.root, r.taskId, true); // a question leaves nothing behind
    if (!r.ok) throw new Error(`orchestrator agent ${name} failed: ${r.error ?? "unknown error"}`);
    const json = extractJson(r.summary);
    if (json === undefined) lastError = "no JSON object found in the reply";
    else {
      const parsed = opts.schema.safeParse(json);
      if (parsed.success) return { value: parsed.data, costUsd: cost };
      lastError = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    }
    prompt = `${prompt}\n\nYour previous reply could not be used (${lastError}). Reply again with only the JSON object in a \`\`\`json block.`;
  }
  throw new Error(`orchestrator agent ${name} did not return a valid answer: ${lastError}`);
}

/** The last JSON object in a reply: from a ```json block if there is one, else the last {...} that parses. */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (const m of fences.reverse()) {
    try {
      return JSON.parse(m[1]!);
    } catch {
      // try the next one
    }
  }
  let found: unknown;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = matchBrace(text, i);
    if (end < 0) continue;
    try {
      found = JSON.parse(text.slice(i, end + 1));
      i = end;
    } catch {
      // not JSON; keep scanning
    }
  }
  return found;
}

function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}
