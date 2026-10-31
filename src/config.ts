import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadLayers } from "./config-layers.ts";
import { condition, evaluate, render } from "./expr.ts";
import { buildKeymap } from "./keymap.ts";
import { PROVIDERS, teamYaml } from "./team.ts";
import type { AgentProfile } from "./types.ts";

/** "90s", "15m", "1h" or plain seconds → milliseconds. */
export function parseDuration(v: string | number): number {
  if (typeof v === "number") return v * 1000;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(v.trim());
  if (!m) throw new Error(`bad duration: ${v}`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"]!;
  return n * unit;
}

export const BUILTIN_CLIS = ["commandcode", "opencode", "claude", "acp", "generic"] as const;

const Duration = z.union([z.string(), z.number()]).transform(parseDuration);

const AgentSchema = z.object({
  cli: z
    .union([z.enum(BUILTIN_CLIS), z.string().regex(/^[a-z][a-z0-9-]*$/, "cli names are lowercase words")])
    .describe("commandcode, opencode, claude (built in); acp (any Agent Client Protocol agent); generic (any CLI, see command); or a cli added by a plugin"),
  command: z
    .array(z.string())
    .min(1)
    .optional()
    .describe("acp: the command that starts the agent, e.g. [gemini, --experimental-acp]. generic: argv with {{task}}, {{model}}, {{cwd}}"),
  output: z.enum(["text", "json", "ndjson"]).optional().describe("generic: how to read the CLI's stdout (default text)"),
  summary: z.string().optional().describe('generic: "last-paragraph" (default), "all", or an expression such as result or last.result'),
  success: z.string().optional().describe('generic: "exit-code" (default) or an expression such as "!is_error"'),
  usage: z
    .object({ input: z.string().optional(), output: z.string().optional(), cost: z.string().optional() })
    .optional()
    .describe("generic json/ndjson: expressions for input/output tokens and cost in USD"),
  models: z.array(z.string()).optional().describe("generic: a command that prints one model id per line (for /model completion)"),
  env: z.record(z.string(), z.string()).optional().describe("Extra environment; values may reference others as env:NAME"),
  model: z.string().optional().describe("Model id for the CLI, e.g. deepseek/deepseek-v4-flash (see `yxu models`)"),
  permission: z
    .enum(["yolo", "accept-edits", "plan"])
    .optional()
    .describe("accept-edits (default): edit files, ask for the rest; plan: read only; yolo: anything, no questions"),
  allow: z.array(z.string()).optional().describe('ACP: tools approved without asking, "kind" or "kind:glob", e.g. ["execute:npm test*"]'),
  deny: z.array(z.string()).optional().describe("ACP: tools always refused"),
  sandbox: z.enum(["bwrap", "none"]).optional().describe("bwrap (Linux): the agent can only write to its worktree and its own state dirs"),
  sandbox_writable: z.array(z.string()).optional().describe("Extra writable paths in the sandbox (~ allowed)"),
  max_turns: z.number().int().positive().optional().describe("Turn limit per task"),
  timeout: Duration.optional().describe('Kill the task after this long: "90s", "15m", "1h" or seconds'),
  agent: z.string().optional().describe("Named agent/persona inside the CLI, if it has them"),
  description: z.string().optional().describe("Tells the orchestrator when to use this agent"),
  instructions: z.string().optional().describe("The agent's role: put before every task it gets (e.g. how a reviewer should report)"),
});

const StepId = z.string().regex(/^[a-z][a-z0-9_-]*$/, "step ids are lowercase words");

/** Fields every step accepts. */
const StepBase = {
  id: StepId,
  description: z.string().optional().describe("What this step is for (shown while it runs)"),
  if: z.union([z.string(), z.boolean()]).optional().describe('Run only when true, e.g. "{{verify.ok}}" or "plan.tasks.length > 3"'),
  unless: z.union([z.string(), z.boolean()]).optional().describe("Skip when true"),
  continue_on_error: z.boolean().optional().describe("Record a failure and keep going instead of stopping the workflow"),
};

const PlanStep = z.object({
  ...StepBase,
  type: z.literal("plan"),
  /** Upper bound on how many tasks the planner may produce. */
  max_tasks: z.number().int().min(1).max(12).default(5),
  instructions: z.string().optional(),
});

const DelegateStep = z.object({
  ...StepBase,
  type: z.literal("delegate"),
  agent: z.string(),
  /** Run one task per item of a plan step's output, in parallel, then combine. */
  for_each: z.string().optional(),
  /** Task text for a single delegate; a template ({{goal}}, {{inputs.x}}, {{<step>.output}}). */
  prompt: z.string().optional(),
});

const VerifyStep = z.object({
  ...StepBase,
  type: z.literal("verify"),
  /** Shell command; defaults to settings.verify. */
  command: z.string().optional(),
  /** Agent that fixes failures; without one, a failed verify fails the pipeline. */
  fix_agent: z.string().optional(),
  max_rounds: z.number().int().min(1).max(10).default(2),
});

const ReviewStep = z.object({
  ...StepBase,
  type: z.literal("review"),
  /** Agent that applies the reviewer's requested fixes. */
  fix_agent: z.string(),
  max_rounds: z.number().int().min(1).max(10).default(3),
  instructions: z.string().optional(),
});

const ShellStep = z.object({
  ...StepBase,
  type: z.literal("shell"),
  command: z.string().describe("Shell command (a template; values are shell-quoted). Output feeds later steps as {{<id>.output}}"),
  in: z.enum(["result", "repo"]).default("result").describe("result: the work so far (task worktree, or the repo before any change); repo: your checkout"),
  timeout: Duration.optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const GateStep = z.object({
  ...StepBase,
  type: z.literal("gate"),
  message: z.string().describe("Question shown before continuing (a template)"),
});

const ParallelStep = z.object({
  ...StepBase,
  type: z.literal("parallel"),
  steps: z
    .array(z.lazy(() => StepSchema))
    .min(1)
    .describe("Steps run at the same time; their changes are combined"),
});

const LoopStep = z.object({
  ...StepBase,
  type: z.literal("loop"),
  steps: z
    .array(z.lazy(() => StepSchema))
    .min(1)
    .describe("Steps repeated in order each round"),
  until: z.union([z.string(), z.boolean()]).optional().describe("Stop once this is true (checked after each round)"),
  max_rounds: z.number().int().min(1).max(20).default(3),
});

const CallStep = z.object({
  ...StepBase,
  type: z.literal("workflow"),
  workflow: z.string().describe("Name of a pipeline workflow to run here"),
  inputs: z.record(z.string(), z.string()).optional().describe("Inputs for that workflow (templates)"),
  goal: z.string().optional().describe("Goal for that workflow (template; default: this workflow's goal)"),
});

type StepFields = z.infer<z.ZodObject<typeof StepBase>>;
export type Step =
  | z.infer<typeof PlanStep>
  | z.infer<typeof DelegateStep>
  | z.infer<typeof VerifyStep>
  | z.infer<typeof ReviewStep>
  | z.infer<typeof ShellStep>
  | z.infer<typeof GateStep>
  | z.infer<typeof CallStep>
  | (StepFields & { type: "parallel"; steps: Step[] })
  | (StepFields & { type: "loop"; steps: Step[]; until?: string | boolean; max_rounds: number });

const StepSchema: z.ZodType<Step> = z.discriminatedUnion("type", [
  PlanStep,
  DelegateStep,
  VerifyStep,
  ReviewStep,
  ShellStep,
  GateStep,
  ParallelStep,
  LoopStep,
  CallStep,
]);

const InputSchema = z.object({
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Inputs without a default are required unless this says otherwise. */
  required: z.boolean().optional(),
});

const WorkflowSchema = z.object({
  mode: z.enum(["auto", "pipeline"]).default("auto"),
  description: z.string().optional().describe("Shown in /workflow"),
  allowed_agents: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  steps: z.array(StepSchema).optional(),
  inputs: z.record(z.string(), InputSchema).optional().describe("Values passed with --input name=value or by a command"),
  outputs: z.record(z.string(), z.string()).optional().describe("Results reported at the end (templates)"),
});

/** Token counts: 200000, "200k", "1m". */
export function parseTokens(v: string | number): number {
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(v.trim());
  if (!m) throw new Error(`bad token count: ${v}`);
  return Math.round(Number(m[1]) * (m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2] ? 1_000 : 1));
}

const Tokens = z.union([z.number(), z.string()]).transform((v, ctx) => {
  try {
    return parseTokens(v);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

/** What the orchestrator gets to see, and whether it remembers earlier messages. */
const ContextSchema = z
  .object({
    /** Interactive sessions continue the same orchestrator conversation across messages. */
    memory: z.boolean().default(true),
    /** Load the project's CLAUDE.md / .claude settings into the orchestrator. */
    project_instructions: z.boolean().default(true),
    /** Files (relative to the repo root) added to the orchestrator's context on every run. */
    include: z.array(z.string()).default([]),
    /** Per-file cap for included files, in characters. */
    include_max_chars: z.number().int().positive().default(20_000),
    /** Standing notes for the orchestrator (conventions, constraints, priorities). */
    notes: z.string().optional(),
    /** Max characters of a subagent's diff shown to the orchestrator (overrides settings.max_diff_chars). */
    max_diff_chars: z.number().int().positive().optional(),
    repo_map: z
      .boolean()
      .default(true)
      .describe("Share a map of the repo (files, symbols, tests, conventions) with every agent: the relevant part goes before each task, the overview to the orchestrator"),
    repo_map_chars: z.number().int().min(500).max(50_000).default(4000).describe("Characters of the repo map put before each subagent task"),
  })
  .default({ memory: true, project_instructions: true, include: [], include_max_chars: 20_000, repo_map: true, repo_map_chars: 4000 });

/** How long orchestrator conversations are summarized when they grow. */
const CompactSchema = z
  .object({
    /** Compact automatically when the conversation nears the window. */
    auto: z.boolean().default(true),
    /** Window to compact against, in tokens (100k–1M), or "auto" for the model's own. */
    window: z.union([z.literal("auto"), Tokens]).default("auto"),
    /** What a summary must keep (used for /compact, and given to the model for auto-compaction). */
    instructions: z.string().optional(),
    /** Warn in the interface when context use passes this fraction of the window. */
    warn_at: z.number().min(0.1).max(1).default(0.8),
    /** Compact between turns, in the background, so the orchestrator never stops mid-run to do it. */
    background: z
      .boolean()
      .default(true)
      .describe("Interface: after a turn, compact a copy of the conversation in the background; you keep working, and the summary takes over when it is ready"),
    background_at: z
      .number()
      .min(0.1)
      .max(0.95)
      .default(0.6)
      .describe("Start background compaction when context use passes this fraction of the window (before Claude Code's own auto-compaction, which pauses the run)"),
  })
  .default({ auto: true, window: "auto", warn_at: 0.8, background: true, background_at: 0.6 });

export const CONFIG_VERSION = 1;

export const ConfigSchema = z.object({
  extends: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Shared bases merged under this file: ./base.yaml, github:owner/repo/path.yaml[@ref] (pinned in yxu.lock)"),
  orchestrator: z
    .object({
      model: z.string().default("opus").describe("Claude model that plans, delegates and reviews"),
      provider: z
        .string()
        .default("claude")
        .describe("Who answers pipeline plan and review steps: claude (default), agent (orchestrator.agent), or an orchestrator added by a plugin. Auto workflows need claude"),
      agent: z.string().optional().describe("provider: agent — the agent that plans and reviews (read-only, in its own worktree)"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("Reasoning effort for the orchestrator"),
      max_budget_usd: z.number().positive().optional().describe("Stop the orchestrator when a run spends more than this"),
      max_turns: z.number().int().positive().optional().describe("Orchestrator turn limit per run"),
      /** Load the user's global Claude settings (plugins, hooks, MCP servers). Off: much cheaper. */
      user_settings: z.boolean().default(false).describe("Load your global Claude settings, plugins and MCP servers (costly)"),
    })
    .default({ model: "opus", provider: "claude", user_settings: false }),
  agents: z.record(z.string(), AgentSchema).describe("Local agent CLIs the orchestrator can delegate to"),
  workflows: z.record(z.string(), WorkflowSchema).default({}).describe("How the orchestrator works: auto, or a fixed pipeline of steps"),
  settings: z
    .object({
      max_diff_chars: z.number().int().positive().default(12_000),
      /** How many subagents may run at the same time. */
      concurrency: z.number().int().min(1).max(16).default(3),
      /** Default agent for resolving merge conflicts in `combine`. */
      resolver: z.string().optional(),
      default_agent: z
        .string()
        .optional()
        .describe('The agent a workflow step means by `agent: default` (packs use this); default: the first agent'),
      /** Command that checks a task's result, e.g. "npm test". Used by verify steps and the verify tool. */
      verify: z.string().optional(),
      verify_timeout: Duration.default(600_000), // zod 4: defaults bypass the transform, so this is already ms
      apply: z
        .enum(["auto", "ask", "manual"])
        .default("auto")
        .describe("How results reach your working tree: auto (applied when a run ends, /undo reverts), ask (you choose: apply, diff, later, discard), manual (/apply)"),
      permissions: z
        .enum(["ask", "auto", "full"])
        .default("ask")
        .describe("How much runs without asking: ask (ask for approval), auto (a classifier approves or blocks each action, asks when unsure), full (everything runs; agents get yolo)"),
      auto_model: z.string().default("haiku").describe("The model that approves or blocks actions in permissions: auto"),
      checkout_commands: z
        .enum(["ask", "allow", "off"])
        .default("ask")
        .describe("Commands the orchestrator runs in your own checkout (git commit, push, …): ask before each (default), allow without asking, or off"),
    })
    .default({ max_diff_chars: 12_000, concurrency: 3, verify_timeout: 600_000, apply: "auto", permissions: "ask", auto_model: "haiku", checkout_commands: "ask" }),
  context: ContextSchema,
  compact: CompactSchema,
  spawn: z
    .object({
      enabled: z.boolean().default(true).describe("Let the orchestrator create subagents for a session (spawn_agent)"),
      models: z
        .record(z.string(), z.array(z.string()).min(1))
        .optional()
        .describe("The providers and models it may spawn with, e.g. { commandcode: [deepseek/deepseek-v4-pro], claude: [sonnet] }; default: the cli/model pairs your agents use"),
      max: z.number().int().min(1).max(50).default(8).describe("Most subagents it may spawn in one session"),
    })
    .default({ enabled: true, max: 8 })
    .describe("Subagents the orchestrator creates on its own, from providers and models you choose"),
  hooks: z
    .object({
      before_run: z.array(z.string()).optional().describe("Before a run; a failing command blocks it"),
      after_task: z.array(z.string()).optional().describe("After each agent task, in its worktree; file changes join the task"),
      before_apply: z.array(z.string()).optional().describe("Before apply, in the task's worktree; a failing command blocks the apply"),
      on_failure: z.array(z.string()).optional().describe("After a run that failed"),
      on_complete: z.array(z.string()).optional().describe("After a run that succeeded"),
    })
    .optional()
    .describe("Shell commands at lifecycle points; they get the event as JSON on stdin"),
  ui: z
    .object({
      theme: z.string().default("instrument").describe("instrument, high-contrast, light, mono, or a file in ~/.config/yxu/themes"),
      keys: z.record(z.string(), z.string()).default({}).describe('Rebind interface keys, e.g. { panel: ctrl+b } (see `yxu keys`)'),
      panel: z.boolean().default(true).describe("Open the side panel at start"),
      panel_sections: z
        .array(z.union([z.enum(["context", "agents", "tasks", "cost"]), z.string().regex(/^[a-z][a-z0-9-]*:.+$/, 'plugin sections are "<plugin>:<title>"')]))
        .default(["context", "agents", "tasks", "cost"])
        .describe('Which panel sections to show, in order; plugin sections are "<plugin>:<title>" (shown after these unless listed)'),
      footer: z.boolean().default(true).describe("Show the key hints line"),
      mouse: z
        .boolean()
        .default(true)
        .describe("The mouse wheel scrolls the conversation (select text with shift+drag). false: your terminal handles the mouse"),
    })
    .default({ theme: "instrument", keys: {}, panel: true, panel_sections: ["context", "agents", "tasks", "cost"], footer: true, mouse: true })
    .describe("The interactive interface: theme, keys, layout"),
});

export type RawAgent = z.infer<typeof AgentSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type Config = z.infer<typeof ConfigSchema> & {
  /** Plugins loaded for this repo (non-enumerable; filled by loadLayers). */
  plugins?: import("./plugins.ts").PluginRegistry;
  /** Human-readable list of the files that make up this config. */
  source: string;
  /** Which layer set each value ("orchestrator.model" → "local"); filled by loadLayers. */
  origins?: Record<string, string>;
  /** Whether the user trusts this repo to run commands from its own config (see trust.ts). */
  trusted?: boolean;
};
export type ContextConfig = Config["context"];
export type CompactConfig = Config["compact"];

export const SCHEMA_URL = "https://raw.githubusercontent.com/yxu173/yxu-code/main/schema/yxu.schema.json";
export const SCHEMA_COMMENT = `# yaml-language-server: $schema=${SCHEMA_URL}`;

/** The built-in config (until a file defines agents): the starter team on Command Code, OpenCode and Claude. */
export const DEFAULT_YAML = teamYaml(
  { providers: ["commandcode", "opencode", "claude"].map((id) => PROVIDERS.find((p) => p.id === id)!), verify: "npm test" },
  SCHEMA_COMMENT,
  "built in (`yxu init` writes one that fits your machine)",
);

/** Agent clis and orchestrators that plugins add (for validation). */
export interface Extensions {
  clis: string[];
  orchestrators: string[];
}

/** Validate a merged raw config. `where(path)` names the file a bad value came from. */
export function validateConfig(raw: unknown, source: string, where: (path: string) => string = () => source, ext: Extensions = { clis: [], orchestrators: [] }): Config {
  const parsed = ConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const path = i.path.join(".");
      return `  ${path || "(root)"}: ${i.message}${path && where(path) !== source ? `  (from ${where(path)})` : ""}`;
    });
    throw new Error(`invalid config ${source}:\n${issues.join("\n")}`);
  }
  const cfg: Config = { ...parsed.data, source };
  const bad = (path: string, msg: string) => new Error(`invalid config ${where(path)}: ${msg}`);
  const win = cfg.compact.window;
  if (win !== "auto" && (win < 100_000 || win > 1_000_000)) {
    throw bad("compact.window", `compact.window must be "auto" or between 100k and 1m tokens`);
  }
  if (cfg.context.max_diff_chars) cfg.settings.max_diff_chars = cfg.context.max_diff_chars;
  try {
    buildKeymap(cfg.ui.keys);
  } catch (e) {
    throw bad("ui.keys", (e as Error).message);
  }
  const provider = cfg.orchestrator.provider;
  if (provider !== "claude" && provider !== "agent" && !ext.orchestrators.includes(provider)) {
    throw bad("orchestrator.provider", `orchestrator.provider "${provider}" is not claude, agent${ext.orchestrators.length ? `, ${ext.orchestrators.join(", ")}` : ""} (plugins can add more; see \`yxu plugins\`)`);
  }
  if (provider === "agent") {
    if (!cfg.orchestrator.agent) throw bad("orchestrator.agent", "orchestrator.provider: agent needs orchestrator.agent (the agent that plans and reviews)");
    if (!cfg.agents[cfg.orchestrator.agent]) throw bad("orchestrator.agent", `orchestrator.agent "${cfg.orchestrator.agent}" is not an agent`);
  }
  for (const [name, a] of Object.entries(cfg.agents)) {
    const abad = (msg: string, field?: string) => bad(`agents.${name}${field ? `.${field}` : ""}`, `agent "${name}": ${msg}`);
    if (!(BUILTIN_CLIS as readonly string[]).includes(a.cli) && !ext.clis.includes(a.cli)) {
      throw abad(`unknown cli "${a.cli}" (built in: ${BUILTIN_CLIS.join(", ")}${ext.clis.length ? `; from plugins: ${ext.clis.join(", ")}` : ""}). If a plugin adds it, check \`yxu plugins\`: it may wait for approval`, "cli");
    }
    if ((a.cli === "acp" || a.cli === "generic") && !a.command) throw abad(`cli: ${a.cli} needs \`command\``);
    if (a.cli !== "acp" && a.cli !== "generic" && a.command) throw abad(`\`command\` is only for cli: acp or generic`);
    if (a.cli === "generic" && !a.command!.some((x) => x.includes("{{task}}") || x.includes("{{ task }}"))) {
      throw abad("the generic command must pass the task somewhere, e.g. --message {{task}}");
    }
    if (a.cli !== "generic" && (a.output || a.summary || a.success || a.usage || a.models)) throw abad("output/summary/success/usage/models are for cli: generic");
    if (a.cli !== "acp" && (a.allow || a.deny)) throw abad("allow/deny apply to ACP agents (other CLIs decide permissions themselves)");
    for (const p of [...(a.allow ?? []), ...(a.deny ?? [])]) {
      if (!/^[a-z_]+(:.+)?$/.test(p)) throw abad(`bad tool pattern "${p}" (use "kind" or "kind:glob", e.g. "execute:npm test*")`);
    }
    for (const [what, tpl] of [["summary", a.summary], ["success", a.success], ...Object.entries(a.usage ?? {})] as const) {
      if (!tpl || ["last-paragraph", "all", "exit-code"].includes(tpl)) continue;
      try {
        evaluate(tpl, {});
      } catch (e) {
        throw abad(`${what}: ${(e as Error).message}`);
      }
    }
  }
  for (const cli of Object.keys(cfg.spawn.models ?? {})) {
    if (cli === "acp" || cli === "generic") throw bad("spawn.models", `spawn.models: ${cli} agents need a command, so they can't be spawned; define them under agents`);
    if (!(BUILTIN_CLIS as readonly string[]).includes(cli) && !ext.clis.includes(cli)) throw bad("spawn.models", `spawn.models: unknown cli "${cli}" (built in: commandcode, opencode, claude${ext.clis.length ? `; from plugins: ${ext.clis.join(", ")}` : ""})`);
  }
  if (cfg.settings.default_agent && !cfg.agents[cfg.settings.default_agent]) {
    throw bad("settings.default_agent", `settings.default_agent "${cfg.settings.default_agent}" is not an agent`);
  }
  // `agent: default` in a step (used by shared packs) means settings.default_agent or the first agent.
  const fallback = cfg.settings.default_agent ?? Object.keys(cfg.agents)[0];
  if (!cfg.agents.default && fallback) {
    const point = (steps: Step[] = []) => {
      for (const st of steps) {
        if (st.type === "delegate" && st.agent === "default") st.agent = fallback;
        if ((st.type === "verify" || st.type === "review") && st.fix_agent === "default") st.fix_agent = fallback;
        if (st.type === "parallel" || st.type === "loop") point(st.steps);
      }
    };
    for (const wf of Object.values(cfg.workflows)) point(wf.steps);
  }
  if (cfg.settings.resolver && !cfg.agents[cfg.settings.resolver]) {
    throw bad("settings.resolver", `settings.resolver "${cfg.settings.resolver}" is not an agent`);
  }
  for (const [name, wf] of Object.entries(cfg.workflows)) {
    const wbad = (msg: string) => bad(`workflows.${name}`, `workflow "${name}": ${msg}`);
    for (const a of wf.allowed_agents ?? []) {
      if (!cfg.agents[a]) throw wbad(`allows unknown agent "${a}"`);
    }
    if (wf.mode === "pipeline" && !wf.steps?.length) throw wbad("pipeline mode needs steps");
    if (wf.mode === "auto" && wf.steps) throw wbad("steps are only used in pipeline mode");
    const syntax = (what: string, src: string | boolean | undefined, asCondition = false) => {
      if (typeof src !== "string") return;
      try {
        if (asCondition) condition(src, {});
        else render(src, {});
      } catch (e) {
        throw wbad(`${what}: ${(e as Error).message}`);
      }
    };
    for (const [k, tpl] of Object.entries(wf.outputs ?? {})) syntax(`output "${k}"`, tpl);
    const seen = new Map<string, Step["type"]>();
    const walk = (steps: Step[]) => {
      for (const step of steps) {
        if (seen.has(step.id)) throw wbad(`duplicate step id "${step.id}"`);
        if (["goal", "inputs", "head", "settings", "outputs"].includes(step.id)) throw wbad(`step id "${step.id}" is reserved`);
        syntax(`step "${step.id}" if`, step.if, true);
        syntax(`step "${step.id}" unless`, step.unless, true);
        const agents = [
          step.type === "delegate" ? step.agent : undefined,
          step.type === "verify" || step.type === "review" ? step.fix_agent : undefined,
        ];
        for (const a of agents) if (a && !cfg.agents[a]) throw wbad(`step "${step.id}" uses unknown agent "${a}"`);
        switch (step.type) {
          case "delegate":
            if (step.for_each) {
              if (seen.get(step.for_each) !== "plan") throw wbad(`step "${step.id}": for_each must name an earlier plan step`);
            } else if (!step.prompt) {
              throw wbad(`step "${step.id}" needs a prompt or for_each`);
            }
            syntax(`step "${step.id}" prompt`, step.prompt);
            break;
          case "verify":
            if (!step.command && !cfg.settings.verify) throw wbad(`step "${step.id}" needs a command (or set settings.verify)`);
            break;
          case "shell":
            syntax(`step "${step.id}" command`, step.command);
            break;
          case "gate":
            syntax(`step "${step.id}" message`, step.message);
            break;
          case "loop":
            syntax(`step "${step.id}" until`, step.until, true);
            break;
          case "workflow": {
            const target = cfg.workflows[step.workflow];
            if (!target) throw wbad(`step "${step.id}" calls unknown workflow "${step.workflow}"`);
            if (target.mode !== "pipeline") throw wbad(`step "${step.id}": workflow "${step.workflow}" is not a pipeline`);
            for (const [k, tpl] of Object.entries(step.inputs ?? {})) syntax(`step "${step.id}" input "${k}"`, tpl);
            break;
          }
        }
        seen.set(step.id, step.type);
        if (step.type === "parallel" || step.type === "loop") walk(step.steps);
      }
    };
    walk(wf.steps ?? []);
  }
  // Workflows calling workflows must not loop back on themselves.
  const calls = (steps: Step[] = []): string[] =>
    steps.flatMap((st) => (st.type === "workflow" ? [st.workflow] : st.type === "parallel" || st.type === "loop" ? calls(st.steps) : []));
  const visit = (name: string, stack: string[]) => {
    if (stack.includes(name)) throw bad(`workflows.${name}`, `workflows call each other in a cycle: ${[...stack, name].join(" → ")}`);
    for (const next of calls(cfg.workflows[name]?.steps)) visit(next, [...stack, name]);
  };
  for (const name of Object.keys(cfg.workflows)) visit(name, []);
  return cfg;
}

/** Parse and validate one complete config file (no layering). */
export function parseConfig(text: string, source: string): Config {
  const raw = (parseYaml(text) ?? {}) as Record<string, unknown>;
  const { version: _version, ...rest } = raw;
  return validateConfig(rest, source);
}

/** All layers merged: defaults → user → project → local → env (see config-layers.ts). */
export function loadConfig(root: string, opts: { sets?: string[]; env?: NodeJS.ProcessEnv } = {}): Config {
  return loadLayers(root, opts).config;
}

/** The default when an agent sets no permission: edits only. `yolo` must be chosen explicitly. */
export const DEFAULT_PERMISSION = "accept-edits" as const;

export function toProfile(a: RawAgent): AgentProfile {
  return {
    cli: a.cli,
    model: a.model,
    permission: a.permission ?? DEFAULT_PERMISSION,
    maxTurns: a.max_turns,
    timeoutMs: a.timeout,
    agent: a.agent,
    command: a.cli === "acp" ? a.command : undefined,
    generic:
      a.cli === "generic"
        ? { command: a.command!, output: a.output ?? "text", summary: a.summary ?? "last-paragraph", success: a.success ?? "exit-code", usage: a.usage }
        : undefined,
    env: a.env ? resolveEnv(a.env) : undefined,
    allow: a.allow,
    deny: a.deny,
    sandbox: a.sandbox,
    sandboxWritable: a.sandbox_writable,
  };
}

/** `env:NAME` values come from the environment, so secrets never live in config files. */
export function resolveEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => {
      const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(v);
      return [k, m ? (process.env[m[1]!] ?? "") : v];
    }),
  );
}

/** The providers and models the orchestrator may spawn subagents with: spawn.models, or what your agents use. */
export function spawnPool(cfg: Config): Record<string, string[]> {
  if (cfg.spawn.models) return cfg.spawn.models;
  const pool: Record<string, string[]> = {};
  for (const a of Object.values(cfg.agents)) {
    if (a.cli === "acp" || a.cli === "generic" || !a.model) continue; // those need a command, or name no model
    pool[a.cli] = [...new Set([...(pool[a.cli] ?? []), a.model])];
  }
  return pool;
}

/** Where the config names an agent (so removing it would break those places). */
export function agentRefs(cfg: Config, name: string): string[] {
  const refs: string[] = [];
  if (cfg.settings.resolver === name) refs.push("settings.resolver");
  if (cfg.settings.default_agent === name) refs.push("settings.default_agent");
  if (cfg.orchestrator.agent === name) refs.push("orchestrator.agent");
  const walk = (wf: string, steps: Step[] = []) => {
    for (const st of steps) {
      if ((st.type === "delegate" && st.agent === name) || ((st.type === "verify" || st.type === "review") && st.fix_agent === name)) refs.push(`workflow ${wf}, step ${st.id}`);
      if (st.type === "parallel" || st.type === "loop") walk(wf, st.steps);
    }
  };
  for (const [wf, w] of Object.entries(cfg.workflows)) {
    if (w.allowed_agents?.includes(name)) refs.push(`workflow ${wf}, allowed_agents`);
    walk(wf, w.steps);
  }
  return refs;
}

/** Who orchestrates, for display: "opus", "agent oc", or a plugin orchestrator's name. */
export function orchestratorLabel(cfg: Config): string {
  const p = cfg.orchestrator.provider ?? "claude";
  return p === "claude" ? cfg.orchestrator.model : p === "agent" ? `agent ${cfg.orchestrator.agent}` : `${p} (plugin)`;
}

export function getWorkflow(cfg: Config, name: string | undefined): Workflow & { name: string } {
  const key = name ?? "default";
  const wf = cfg.workflows[key];
  if (wf) return { ...wf, name: key };
  if (name) throw new Error(`unknown workflow "${name}" (have: ${Object.keys(cfg.workflows).join(", ") || "none"})`);
  return { mode: "auto", name: "default" };
}
