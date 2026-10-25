/**
 * Custom slash commands: Markdown files with YAML front matter.
 *   ~/.config/yxu/commands/<name>.md   (personal)    <repo>/.yxu/commands/<name>.md   (team; wins)
 *
 *   ---
 *   description: Add tests for a file and make them pass
 *   args: [file]                  # or [{ name: file, complete: file, required: false, default: … }]
 *   workflow: feature             # optional; for kind: workflow it is required
 *   agents: [coder]               # optional: limit the agents for this command
 *   ---
 *   Write thorough unit tests for {{file}}. Run {{settings.verify}}.
 *
 * Kinds: prompt (default: the body is the goal), workflow (runs `workflow` with `inputs`, the
 * body becomes its goal), shell (the body, or `command:`, runs in the repo and shows its output).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config, Workflow } from "./config.ts";
import { userConfigDir } from "./config-layers.ts";
import { render, type Scope } from "./expr.ts";
import { frontMatter } from "./prompts.ts";

const ArgSpec = z.union([
  z.string().regex(/^[a-z][\w-]*$/i, "arg names are words"),
  z.object({
    name: z.string().regex(/^[a-z][\w-]*$/i, "arg names are words"),
    description: z.string().optional(),
    complete: z.enum(["file", "agent", "workflow", "none"]).optional(),
    required: z.boolean().optional(),
    default: z.string().optional(),
  }),
]);

const Meta = z
  .object({
    description: z.string().optional(),
    kind: z.enum(["prompt", "workflow", "shell"]).optional(),
    args: z.array(ArgSpec).default([]),
    workflow: z.string().optional(),
    agents: z.array(z.string()).optional(),
    inputs: z.record(z.string(), z.string()).optional(),
    command: z.string().optional(),
  })
  .strict();

export interface CommandArg {
  name: string;
  description?: string;
  complete: "file" | "agent" | "workflow" | "none";
  required: boolean;
  default?: string;
}

export interface UserCommand {
  name: string;
  file: string;
  scope: "user" | "project";
  kind: "prompt" | "workflow" | "shell";
  description: string;
  args: CommandArg[];
  workflow?: string;
  agents?: string[];
  inputs?: Record<string, string>;
  /** Prompt / goal template, or the shell command for kind: shell. */
  body: string;
}

export type Expanded =
  | { kind: "prompt"; goal: string; workflow?: Workflow & { name: string } }
  | { kind: "workflow"; goal: string; workflow: Workflow & { name: string }; inputs: Record<string, string> }
  | { kind: "shell"; command: string };

const guessComplete = (name: string): CommandArg["complete"] =>
  /^(file|path|files|paths)$/.test(name) ? "file" : name === "agent" ? "agent" : name === "workflow" ? "workflow" : "none";

/** Parse one command file. Throws with a message naming the file. */
export function parseCommandFile(text: string, file: string, scope: UserCommand["scope"], cfg: Config): UserCommand {
  const name = /([\w-]+)\.md$/.exec(file)?.[1]?.toLowerCase();
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${file}: command file names are lowercase words, e.g. add-tests.md`);
  let fm: ReturnType<typeof frontMatter>;
  try {
    fm = frontMatter(text);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  const parsed = Meta.safeParse(fm.meta);
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "front matter"}: ${i.message}`).join("; ")}`);
  const m = parsed.data;
  const kind = m.kind ?? (m.command ? "shell" : m.inputs ? "workflow" : "prompt");
  const body = (kind === "shell" ? (m.command ?? fm.body) : fm.body).trim();
  const bad = (msg: string) => new Error(`${file}: ${msg}`);
  if (kind === "shell" && !body) throw bad("a shell command needs `command:` or a body");
  if (kind === "prompt" && !body) throw bad("the body is the prompt, and it is empty");
  if (kind === "workflow" && !m.workflow) throw bad("kind: workflow needs `workflow:`");
  if (m.workflow) {
    const wf = cfg.workflows[m.workflow];
    if (!wf) throw bad(`unknown workflow "${m.workflow}"`);
    if (kind === "workflow" && wf.mode !== "pipeline") throw bad(`workflow "${m.workflow}" is not a pipeline`);
  }
  for (const a of m.agents ?? []) if (!cfg.agents[a]) throw bad(`unknown agent "${a}"`);
  const args: CommandArg[] = m.args.map((a) => {
    const spec = typeof a === "string" ? { name: a } : a;
    return {
      name: spec.name,
      description: "description" in spec ? spec.description : undefined,
      complete: ("complete" in spec && spec.complete) || guessComplete(spec.name),
      required: ("required" in spec ? spec.required : undefined) ?? !("default" in spec && spec.default !== undefined),
      default: "default" in spec ? spec.default : undefined,
    };
  });
  // Catch template mistakes now, not when someone runs the command.
  for (const [what, tpl] of [["body", body], ...Object.entries(m.inputs ?? {}).map(([k, v]) => [`input ${k}`, v])] as const) {
    try {
      render(tpl, {});
    } catch (e) {
      throw bad(`${what}: ${(e as Error).message}`);
    }
  }
  return { name, file, scope, kind, description: m.description ?? (kind === "shell" ? `run: ${body.split("\n")[0]}` : body.split("\n")[0]!.slice(0, 80)), args, workflow: m.workflow, agents: m.agents, inputs: m.inputs, body };
}

/** All custom commands (project ones replace personal ones with the same name), plus load errors. */
export function loadUserCommands(root: string, cfg: Config, reserved: string[] = []): { commands: UserCommand[]; errors: string[] } {
  const byName = new Map<string, UserCommand>();
  const errors: string[] = [];
  for (const [scope, dir] of [["user", join(userConfigDir(), "commands")], ["project", join(root, ".yxu", "commands")]] as const) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".md")) continue;
      const file = join(dir, entry);
      try {
        const c = parseCommandFile(readFileSync(file, "utf8"), file, scope, cfg);
        if (reserved.includes(c.name)) {
          errors.push(`${file}: /${c.name} is a built-in command; rename the file`);
          continue;
        }
        byName.set(c.name, c);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }
  return { commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

export function commandUsage(c: UserCommand): string {
  return c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
}

/** Bind typed arguments (the last one takes the rest of the line) and fill the templates. */
export function expandCommand(c: UserCommand, argv: string[], cfg: Config): Expanded {
  const named: Record<string, string> = {};
  c.args.forEach((a, i) => {
    const v = i === c.args.length - 1 ? argv.slice(i).join(" ") : argv[i];
    if (v !== undefined && v !== "") named[a.name] = v;
    else if (a.default !== undefined) named[a.name] = a.default;
    else if (a.required) throw new Error(`/${c.name} needs <${a.name}>${a.description ? ` (${a.description})` : ""} — usage: /${c.name} ${commandUsage(c)}`);
  });
  const scope: Scope = { ...named, args: argv.join(" "), settings: { verify: cfg.settings.verify } };
  const workflowOf = (name: string) => {
    const wf = cfg.workflows[name];
    if (!wf) throw new Error(`/${c.name}: unknown workflow "${name}"`);
    return { ...wf, name, ...(c.agents ? { allowed_agents: c.agents } : {}) };
  };
  switch (c.kind) {
    case "shell":
      return { kind: "shell", command: render(c.body, scope, { shell: true }) };
    case "workflow": {
      const workflow = workflowOf(c.workflow!);
      const declared = Object.keys(workflow.inputs ?? {});
      // Without an explicit mapping, args with the same name as an input fill it.
      const tpl = c.inputs ?? Object.fromEntries(declared.filter((k) => k in named).map((k) => [k, `{{${k}}}`]));
      const inputs = Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, render(v, scope)]));
      return { kind: "workflow", goal: render(c.body, scope), workflow, inputs };
    }
    case "prompt": {
      const goal = render(c.body, scope);
      if (c.workflow) return { kind: "prompt", goal, workflow: workflowOf(c.workflow) };
      if (c.agents) return { kind: "prompt", goal, workflow: { ...(cfg.workflows.default ?? { mode: "auto" as const }), name: "default", allowed_agents: c.agents } };
      return { kind: "prompt", goal };
    }
  }
}
