/**
 * The starter team: agents by role (scout, coder, builder, tester, debugger, reviewer, resolver,
 * docs, expert, backup), each with a role prompt, mapped onto whichever agent CLIs are installed,
 * plus the workflows that use them. `yxu init` writes it; it is also the built-in default config.
 */

/** How strong a model a role needs. */
export type Tier = "fast" | "strong" | "expert";

/** An agent CLI and the models it uses per tier. */
export interface Provider {
  id: string;
  cli: "commandcode" | "opencode" | "claude" | "acp";
  bin: string;
  command?: string[];
  models: Partial<Record<Tier, string>>;
  label: string;
}

/** Known providers, in order of preference for the main team (cheapest capable first). */
export const PROVIDERS: Provider[] = [
  {
    id: "commandcode",
    cli: "commandcode",
    bin: "cmd",
    models: { fast: "deepseek/deepseek-v4-flash", strong: "deepseek/deepseek-v4-pro", expert: "deepseek/deepseek-v4-pro" },
    label: "Command Code (DeepSeek)",
  },
  {
    id: "opencode",
    cli: "opencode",
    bin: "opencode",
    models: { fast: "opencode/deepseek-v4.1-flash-free", strong: "opencode/deepseek-v4.1-flash-free", expert: "opencode/deepseek-v4.1-flash-free" },
    label: "OpenCode (free DeepSeek)",
  },
  { id: "claude", cli: "claude", bin: "claude", models: { fast: "haiku", strong: "sonnet", expert: "sonnet" }, label: "Claude Code" },
  { id: "gemini", cli: "acp", bin: "gemini", command: ["gemini", "--experimental-acp"], models: {}, label: "Gemini CLI (ACP)" },
];

export interface Role {
  name: string;
  tier: Tier;
  /** Read-only roles answer with a report and change nothing. */
  readOnly?: boolean;
  timeout: string;
  maxTurns?: number;
  /** For the orchestrator: when to use this agent. */
  description: string;
  /** Put before every task this agent gets. */
  instructions: string;
}

export const ROLES: Role[] = [
  {
    name: "scout",
    tier: "fast",
    readOnly: true,
    timeout: "10m",
    maxTurns: 40,
    description:
      "Read-only discovery. Answers questions about the codebase (where is X, how does Y flow, what calls Z, which conventions apply) with file:line references. Changes nothing. Use it before planning work in code you haven't read; run several at once for different areas.",
    instructions: `Role: scout. You explore the codebase and report; you never change it.
- Do not create, edit or delete files, and do not run commands that change anything.
- Search broadly first (file names, grep for symbols and strings), then read the relevant code.
- Report, in this order:
  1. The direct answer, in a few sentences.
  2. The relevant files and symbols as path:line, each with one line on its role.
  3. How data and control flow between them (entry points, callers, side effects).
  4. Conventions to follow: test framework and test locations, error handling, naming, patterns.
  5. Risks, unknowns and anything surprising.
- Be concrete and brief. Quote code only when a few lines say more than a description.`,
  },
  {
    name: "coder",
    tier: "fast",
    timeout: "15m",
    maxTurns: 60,
    description: "Implements small, well-scoped changes (about 1–5 files) quickly and cheaply. The default for most tasks.",
    instructions: `Role: coder. Implement exactly the task, in the style of the surrounding code.
- Read the files you will change, and their callers, before editing.
- Keep the change minimal: no unrelated refactors, renames or formatting churn.
- Update or add tests for the behavior you change when the project has tests, and run them if you can.`,
  },
  {
    name: "builder",
    tier: "strong",
    timeout: "30m",
    maxTurns: 120,
    description: "Larger features and refactors that touch many files or need design decisions. Stronger and slower than coder.",
    instructions: `Role: builder. You implement larger changes that span several files.
- First map the code involved (entry points, callers, tests), then decide the design, then edit.
- Prefer extending existing abstractions over adding parallel ones; keep public interfaces stable unless the task says otherwise.
- Make the change complete: update callers, types, tests and config that depend on what you changed.
- Run the project's build and tests if you can, and fix what you broke.
- In your summary, explain the design choices a reviewer should know about.`,
  },
  {
    name: "tester",
    tier: "strong",
    timeout: "20m",
    maxTurns: 80,
    description: "Writes and extends tests: new behavior, edge cases and regressions, in the project's existing test framework. Use after an implementation task (build_on it).",
    instructions: `Role: tester. You write tests; you change production code only to fix a bug a test exposes (say so).
- Find how the project tests similar code (framework, file locations, helpers, fixtures) and follow it.
- Cover the main behavior, edge cases (empty, boundary, invalid input, errors) and any regression named in the task.
- Tests must be deterministic: no sleeps, network or real clock unless the project already does that.
- Run the tests you wrote. Report which pass, and any failure that points at a real bug.`,
  },
  {
    name: "debugger",
    tier: "strong",
    timeout: "30m",
    maxTurns: 120,
    description: "Finds the root cause of a bug, failing test or broken build and makes the smallest correct fix. Give it the failure output.",
    instructions: `Role: debugger. Find the root cause, then fix it with the smallest correct change.
- Reproduce first: run the failing command or write a failing test that shows the bug.
- Trace the failure to its cause; don't patch the symptom (no special cases for the test, no swallowed errors, no skipped tests).
- Fix it, then run the reproduction again and the nearby tests.
- Report: the root cause in one or two sentences, the fix, and how you verified it.`,
  },
  {
    name: "reviewer",
    tier: "strong",
    readOnly: true,
    timeout: "15m",
    maxTurns: 60,
    description:
      "Read-only code review of a change (delegate with build_on=<task>) or an area of code: bugs, edge cases, security, performance, missing tests. Reports findings by severity with file:line; changes nothing.",
    instructions: `Role: reviewer. You review code and report; you never change it.
- Do not create, edit or delete files, and do not run commands that change anything.
- When the task names a change, it is already in your working copy: read the changed files and their callers.
- Look for, in order: correctness bugs, unhandled errors and edge cases, security problems (injection, secrets, unsafe input), concurrency and resource leaks, performance traps, missing or weak tests, and code that doesn't match the project's conventions.
- Report each finding as: severity (blocker / should-fix / nit), path:line, what is wrong, and a concrete fix.
- Only report real problems you can point to. If the change is good, say so plainly.`,
  },
  {
    name: "resolver",
    tier: "expert",
    timeout: "20m",
    maxTurns: 60,
    description: "Resolves git merge conflicts when parallel work is combined, keeping the intent of every side.",
    instructions: `Role: resolver. You resolve merge conflicts.
- Understand what each side was trying to do before editing; read the surrounding code, not just the markers.
- Keep both intents. When they truly conflict, prefer the version that keeps the code consistent and say what you chose.
- Remove every conflict marker, keep the file compiling, and don't make unrelated changes.`,
  },
  {
    name: "docs",
    tier: "fast",
    timeout: "15m",
    maxTurns: 40,
    description: "Writes and updates documentation (README, docs/, docstrings, changelog) to match the code. Use when behavior or usage changes.",
    instructions: `Role: docs. You write documentation that matches the code exactly.
- Read the code you document; never describe behavior you haven't confirmed.
- Match the project's existing docs: tone, structure, heading style, how examples are written.
- Update every place that mentions what changed (README, docs/, help text, changelog if the project keeps one).
- Prefer short, concrete text and runnable examples over long explanations.`,
  },
  {
    name: "expert",
    tier: "expert",
    timeout: "30m",
    maxTurns: 150,
    description: "Escalation for the hardest problems: subtle logic, concurrency, security, architecture, or a task another agent failed twice. Use sparingly.",
    instructions: `Role: expert. You get the hardest tasks, often after another agent failed.
- Assume the obvious approach was tried. Read the code carefully and find what makes this hard.
- Make the change correct first, then simple. Verify by running the build and tests.
- Explain the root cause and why your approach works.`,
  },
];

export interface TeamAgent {
  name: string;
  provider: Provider;
  model?: string;
  role?: Role;
  description: string;
}

export interface TeamPlan {
  /** Providers to use, preferred first. The first runs most roles. */
  providers: Provider[];
  /** A starter pack that sets the verify command. */
  pack?: string;
  /** The verify command (when no pack sets one). */
  verify?: string;
}

/** Assign every role to a provider: the main provider, with expert roles on Claude when it is there. */
export function teamAgents(providers: Provider[]): TeamAgent[] {
  const main = providers[0] ?? PROVIDERS[0]!;
  const claude = providers.find((p) => p.cli === "claude");
  const agents: TeamAgent[] = ROLES.map((role) => {
    const p = role.tier === "expert" && claude ? claude : main;
    return { name: role.name, provider: p, model: p.models[role.tier], role, description: role.description };
  });
  const backup = providers.find((p) => p !== main && p.cli !== "claude") ?? providers.find((p) => p !== main);
  if (backup) {
    agents.push({
      name: "backup",
      provider: backup,
      model: backup.models.fast,
      description: `Same job as coder on a different CLI (${backup.label}). Use when another agent fails for infrastructure reasons (rate limits, auth, timeouts).`,
    });
  }
  return agents;
}

const q = (s: string) => (/^[\w./@-]+$/.test(s) ? s : JSON.stringify(s));
const block = (text: string, indent: string) =>
  text
    .split("\n")
    .map((l) => (l ? indent + l : ""))
    .join("\n");

/** How the orchestrator should use the team (the default workflow's instructions). */
export function teamInstructions(names: string[]): string {
  const has = (n: string) => names.includes(n);
  return [
    "Your subagents are a team with roles. Pick by role:",
    "- Discovery: before planning work in code you haven't read, ask `scout` (read-only, cheap) instead of reading many files yourself. Run several scouts at once with delegate_parallel for different areas.",
    "- Implementation: `coder` for small, scoped tasks; `builder` for multi-file features and refactors.",
    "- Tests: after an implementation, ask `tester` (build_on that task) to cover the new behavior.",
    "- Failures: when verify fails or a bug's cause is unclear, give `debugger` the failure output (build_on the failing task).",
    "- Review: for non-trivial changes, ask `reviewer` (read-only, build_on the task) and have `coder` fix what it finds.",
    "- Docs: when behavior or usage changes, ask `docs` (build_on the final task).",
    "- Merge conflicts in combine are resolved by `resolver`.",
    `- ${has("backup") ? "If an agent fails for infrastructure reasons (rate limits, auth, timeouts), use `backup`. " : ""}Escalate to \`expert\` only after a task has failed twice.`,
    "Read-only agents (scout, reviewer) change nothing: their summary is the answer, and there is nothing to apply, combine or discard.",
  ].join("\n");
}

/** The commented yxu.yaml for a team. `header` is the first line (the schema comment). */
export function teamYaml(plan: TeamPlan, header: string, intro = "written by `yxu init`"): string {
  const agents = teamAgents(plan.providers);
  const names = agents.map((a) => a.name);
  const hasVerify = Boolean(plan.pack || plan.verify);
  const agentBlocks = agents
    .map((a) => {
      const lines = [`  ${a.name}:`, `    cli: ${a.provider.cli}`];
      if (a.provider.command) lines.push(`    command: [${a.provider.command.map(q).join(", ")}]`);
      if (a.model) lines.push(`    model: ${q(a.model)}`);
      if (a.role?.readOnly) lines.push(`    permission: plan     # read-only`);
      lines.push(`    timeout: ${a.role?.timeout ?? "15m"}`);
      if (a.role?.maxTurns) lines.push(`    max_turns: ${a.role.maxTurns}`);
      lines.push(`    description: ${JSON.stringify(a.description)}`);
      if (a.role) lines.push(`    instructions: |`, block(a.role.instructions, "      "));
      return lines.join("\n");
    })
    .join("\n");
  const verifyLine = plan.pack
    ? `  # verify comes from the ${plan.pack} pack; set it here to override`
    : plan.verify
      ? `  verify: ${q(plan.verify)}   # checks a result (verify steps and the verify tool)`
      : `  # verify: npm test     # set your test command to enable verify steps`;
  const verifyStep = (fix: string) => (hasVerify ? `      - id: verify\n        type: verify\n        fix_agent: ${fix}\n` : "");
  return `${header}
# yxu configuration, ${intro}. Agents are local CLIs; the orchestrator is Claude Code.
# A team by role: scout (discovery) · coder · builder · tester · debugger · reviewer · resolver
# (merge conflicts) · docs · expert${names.includes("backup") ? " · backup" : ""}. Change any of them here or in the interface:
#   /agent <name> model <model>    /agent <name> cli <cli> [model]    /agent new <name> <cli> [model]
# Personal overrides for this repo go in yxu.local.yaml (git-ignored); see \`yxu config\`.
version: 1

orchestrator:
  model: opus            # Claude model that plans, delegates, and reviews
  effort: high
  max_budget_usd: 5      # stop the orchestrator if it spends more than this

agents:
  # permission: accept-edits (default) edits files only · plan: read only
  #             yolo: may run any command without asking (opt in per agent)
  # instructions: the agent's role, put before every task it gets.
${agentBlocks}
  # More agents: \`cli: acp\` for any ACP agent, \`cli: generic\` for any CLI (docs/AGENTS.md).
  # Check one with: yxu agent test <name>

workflows:
  # Claude leads the team and decides who does what.
  default:
    mode: auto
    instructions: |
${block(teamInstructions(names), "      ")}

  # Feature: scout the code → plan → implement in parallel → tests →${hasVerify ? " verify (debugger fixes) →" : ""} review.
  feature:
    mode: pipeline
    description: Scout, plan, build in parallel, test${hasVerify ? ", verify" : ""} and review a feature
    steps:
      - id: scout
        type: delegate
        agent: scout
        prompt: |
          Map the code relevant to this goal, so a planner can split it into tasks:
          {{goal}}
      - id: plan
        type: plan
        max_tasks: 4
        instructions: |
          Use coder for small tasks and builder for tasks spanning many files.
          What the scout found:
          {{scout.summary}}
      - id: implement
        type: delegate
        agent: coder
        for_each: plan
      - id: tests
        type: delegate
        agent: tester
        continue_on_error: true
        prompt: |
          Add tests for the change in your working copy, which implements:
          {{goal}}
${verifyStep("debugger")}      - id: review
        type: review
        fix_agent: coder
        max_rounds: 2

  # Bug fix: the debugger reproduces and fixes →${hasVerify ? " verify →" : ""} review.
  bugfix:
    mode: pipeline
    description: Reproduce a bug with a failing test, fix the root cause${hasVerify ? ", verify" : ""} and review
    steps:
      - id: fix
        type: delegate
        agent: debugger
        prompt: |
          Bug: {{goal}}
          Reproduce it with a failing test, find the root cause, and fix it.
${verifyStep("debugger")}      - id: review
        type: review
        fix_agent: debugger
        max_rounds: 2

  # Code review of the current code (read-only): yxu run -w review "the auth module"
  review:
    mode: pipeline
    description: Read-only review of an area of the code; reports findings
    steps:
      - id: report
        type: delegate
        agent: reviewer
        prompt: "Review this part of the codebase and report findings: {{goal}}"
    outputs:
      findings: "{{report.summary}}"

  # Questions about the codebase (read-only): yxu run -w explore "how does auth work?"
  explore:
    mode: pipeline
    description: Answer a question about the codebase (read-only)
    steps:
      - id: answer
        type: delegate
        agent: scout
        prompt: "{{goal}}"
    outputs:
      answer: "{{answer.summary}}"

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
  warn_at: 0.8            # warn in the TUI at 80% of the window

settings:
  concurrency: 3          # subagents running at the same time
  default_agent: coder    # the agent packs' workflows use (agent: default)
  resolver: resolver      # agent that resolves merge conflicts when combining parallel work
${verifyLine}
`;
}
