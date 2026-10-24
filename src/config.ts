import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
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

const Duration = z.union([z.string(), z.number()]).transform(parseDuration);

const AgentSchema = z.object({
  cli: z.enum(["commandcode", "opencode", "claude"]),
  model: z.string().optional(),
  permission: z.enum(["yolo", "accept-edits", "plan"]).optional(),
  max_turns: z.number().int().positive().optional(),
  timeout: Duration.optional(),
  agent: z.string().optional(),
  description: z.string().optional(),
});

const StepId = z.string().regex(/^[a-z][a-z0-9_-]*$/, "step ids are lowercase words");

const PlanStep = z.object({
  id: StepId,
  type: z.literal("plan"),
  /** Upper bound on how many tasks the planner may produce. */
  max_tasks: z.number().int().min(1).max(12).default(5),
  instructions: z.string().optional(),
});

const DelegateStep = z.object({
  id: StepId,
  type: z.literal("delegate"),
  agent: z.string(),
  /** Run one task per item of a plan step's output, in parallel, then combine. */
  for_each: z.string().optional(),
  /** Task text for a single delegate; supports {{goal}}, {{<step>.summary}}, {{<step>.output}}. */
  prompt: z.string().optional(),
});

const VerifyStep = z.object({
  id: StepId,
  type: z.literal("verify"),
  /** Shell command; defaults to settings.verify. */
  command: z.string().optional(),
  /** Agent that fixes failures; without one, a failed verify fails the pipeline. */
  fix_agent: z.string().optional(),
  max_rounds: z.number().int().min(1).max(10).default(2),
});

const ReviewStep = z.object({
  id: StepId,
  type: z.literal("review"),
  /** Agent that applies the reviewer's requested fixes. */
  fix_agent: z.string(),
  max_rounds: z.number().int().min(1).max(10).default(3),
  instructions: z.string().optional(),
});

const StepSchema = z.discriminatedUnion("type", [PlanStep, DelegateStep, VerifyStep, ReviewStep]);

const WorkflowSchema = z.object({
  mode: z.enum(["auto", "pipeline"]).default("auto"),
  allowed_agents: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  steps: z.array(StepSchema).optional(),
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
  })
  .default({ memory: true, project_instructions: true, include: [], include_max_chars: 20_000 });

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
  })
  .default({ auto: true, window: "auto", warn_at: 0.8 });

const ConfigSchema = z.object({
  orchestrator: z
    .object({
      model: z.string().default("opus"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      max_budget_usd: z.number().positive().optional(),
      max_turns: z.number().int().positive().optional(),
      /** Load the user's global Claude settings (plugins, hooks, MCP servers). Off: much cheaper. */
      user_settings: z.boolean().default(false),
    })
    .default({ model: "opus", user_settings: false }),
  agents: z.record(z.string(), AgentSchema),
  workflows: z.record(z.string(), WorkflowSchema).default({}),
  settings: z
    .object({
      max_diff_chars: z.number().int().positive().default(12_000),
      /** How many subagents may run at the same time. */
      concurrency: z.number().int().min(1).max(16).default(3),
      /** Default agent for resolving merge conflicts in `combine`. */
      resolver: z.string().optional(),
      /** Command that checks a task's result, e.g. "npm test". Used by verify steps and the verify tool. */
      verify: z.string().optional(),
      verify_timeout: Duration.default(600_000), // zod 4: defaults bypass the transform, so this is already ms
    })
    .default({ max_diff_chars: 12_000, concurrency: 3, verify_timeout: 600_000 }),
  context: ContextSchema,
  compact: CompactSchema,
});

export type RawAgent = z.infer<typeof AgentSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Config = z.infer<typeof ConfigSchema> & { source: string };
export type ContextConfig = Config["context"];
export type CompactConfig = Config["compact"];

export const DEFAULT_YAML = `# yxu configuration. Agents are local CLIs; the orchestrator is Claude Code.
orchestrator:
  model: opus            # Claude model that plans, delegates, and reviews
  effort: high
  max_budget_usd: 5      # stop the orchestrator if it spends more than this

agents:
  coder:
    cli: commandcode
    model: deepseek/deepseek-v4-flash
    permission: yolo     # yolo | accept-edits | plan
    max_turns: 60
    timeout: 15m
    description: Fast, cheap coder for small well-scoped tasks.
  heavy-coder:
    cli: commandcode
    model: deepseek/deepseek-v4-pro
    timeout: 30m
    description: Stronger DeepSeek model for tasks touching many files.
  oc-coder:
    cli: opencode
    model: opencode/deepseek-v4.1-flash-free
    timeout: 15m
    description: OpenCode with free DeepSeek; good fallback coder.
  claude-coder:
    cli: claude
    model: sonnet
    permission: accept-edits
    timeout: 20m
    description: Claude Sonnet for tricky logic or when DeepSeek fails twice.

workflows:
  default:
    mode: auto
    instructions: |
      Prefer \`coder\` for small tasks and \`heavy-coder\` for tasks touching more than 5 files.
      If \`coder\` is unavailable or fails, use \`oc-coder\`. Escalate to \`claude-coder\`
      only after a DeepSeek agent has failed twice on the same task.

  # A fixed pipeline: plan → implement in parallel → verify (auto-fix) → review loop.
  feature:
    mode: pipeline
    steps:
      - id: plan
        type: plan
        max_tasks: 4
      - id: implement
        type: delegate
        agent: coder
        for_each: plan
      - id: verify
        type: verify
        fix_agent: coder
      - id: review
        type: review
        fix_agent: coder
        max_rounds: 2

# What the orchestrator sees. Change live in the TUI with /context; persist with /context save.
context:
  memory: true            # continue the same orchestrator conversation across messages (TUI)
  project_instructions: true  # load CLAUDE.md
  include: []             # files added to the orchestrator's context, e.g. [docs/ARCHITECTURE.md]
  # notes: |              # standing instructions, e.g. "never touch migrations/"

# Summarizing long orchestrator conversations. Change live with /compact.
compact:
  auto: true              # compact automatically near the window
  window: auto            # or a token count between 100k and 1m, e.g. 200k
  # instructions: Keep task ids, file paths, and the user's decisions.
  warn_at: 0.8            # warn in the TUI at 80% of the window

settings:
  concurrency: 3          # subagents running at the same time
  resolver: claude-coder  # agent that resolves merge conflicts when combining parallel work
  verify: npm test        # command that checks a result (used by verify steps and the verify tool)
`;

export function configPaths(root: string): string[] {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return [join(root, "yxu.yaml"), join(root, "yxu.yml"), join(xdg, "yxu", "config.yaml")];
}

export function parseConfig(text: string, source: string): Config {
  const parsed = ConfigSchema.safeParse(parseYaml(text) ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid config ${source}:\n${issues.join("\n")}`);
  }
  const cfg = { ...parsed.data, source };
  const win = cfg.compact.window;
  if (win !== "auto" && (win < 100_000 || win > 1_000_000)) {
    throw new Error(`invalid config ${source}: compact.window must be "auto" or between 100k and 1m tokens`);
  }
  if (cfg.context.max_diff_chars) cfg.settings.max_diff_chars = cfg.context.max_diff_chars;
  if (cfg.settings.resolver && !cfg.agents[cfg.settings.resolver]) {
    throw new Error(`invalid config ${source}: settings.resolver "${cfg.settings.resolver}" is not an agent`);
  }
  for (const [name, wf] of Object.entries(cfg.workflows)) {
    const bad = (msg: string) => new Error(`invalid config ${source}: workflow "${name}": ${msg}`);
    for (const a of wf.allowed_agents ?? []) {
      if (!cfg.agents[a]) throw bad(`allows unknown agent "${a}"`);
    }
    if (wf.mode === "pipeline" && !wf.steps?.length) throw bad("pipeline mode needs steps");
    if (wf.mode === "auto" && wf.steps) throw bad("steps are only used in pipeline mode");
    const seen = new Map<string, Step["type"]>();
    for (const step of wf.steps ?? []) {
      if (seen.has(step.id)) throw bad(`duplicate step id "${step.id}"`);
      const agents = [
        step.type === "delegate" ? step.agent : undefined,
        step.type === "verify" || step.type === "review" ? step.fix_agent : undefined,
      ];
      for (const a of agents) if (a && !cfg.agents[a]) throw bad(`step "${step.id}" uses unknown agent "${a}"`);
      if (step.type === "delegate") {
        if (step.for_each) {
          if (seen.get(step.for_each) !== "plan") throw bad(`step "${step.id}": for_each must name an earlier plan step`);
        } else if (!step.prompt) {
          throw bad(`step "${step.id}" needs a prompt or for_each`);
        }
      }
      if (step.type === "verify" && !step.command && !cfg.settings.verify) {
        throw bad(`step "${step.id}" needs a command (or set settings.verify)`);
      }
      seen.set(step.id, step.type);
    }
  }
  return cfg;
}

/** Project yxu.yaml, then ~/.config/yxu/config.yaml, then built-in defaults. */
export function loadConfig(root: string): Config {
  for (const p of configPaths(root)) {
    if (existsSync(p)) return parseConfig(readFileSync(p, "utf8"), p);
  }
  return parseConfig(DEFAULT_YAML, "(built-in defaults)");
}

export function toProfile(a: RawAgent): AgentProfile {
  return {
    cli: a.cli,
    model: a.model,
    permission: a.permission,
    maxTurns: a.max_turns,
    timeoutMs: a.timeout,
    agent: a.agent,
  };
}

export function getWorkflow(cfg: Config, name: string | undefined): Workflow & { name: string } {
  const key = name ?? "default";
  const wf = cfg.workflows[key];
  if (wf) return { ...wf, name: key };
  if (name) throw new Error(`unknown workflow "${name}" (have: ${Object.keys(cfg.workflows).join(", ") || "none"})`);
  return { mode: "auto", name: "default" };
}
