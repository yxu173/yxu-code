import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TaskOps } from "../ops.ts";
import { loadRepoMap, mapSlice } from "../repomap.ts";
import { spawnPool } from "../config.ts";

export { Session, type OpsHooks as ToolHooks } from "../ops.ts";

export const SERVER_NAME = "yxu";
export const TOOL_NAMES = ["list_agents", "spawn_agent", "delegate", "delegate_parallel", "combine", "verify", "get_diff", "discard", "find_code", "run_in_checkout"].map(
  (t) => `mcp__${SERVER_NAME}__${t}`,
);

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const errorText = (s: string) => ({ ...text(s), isError: true });

/** Wrap a handler so thrown errors become tool errors the model can read. */
const safe =
  <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return errorText((e as Error).message);
    }
  };

/** A long tool (subagents, merges, checks): the orchestrator waits on it, so compaction can run meanwhile. */
const watched =
  <A>(watch: ToolWatch | undefined, name: string, fn: (args: A) => Promise<ReturnType<typeof text>>) =>
  async (args: A) => {
    watch?.toolStart();
    const res = await safe(fn)(args);
    watch?.toolEnd(name, res.content.map((c) => c.text).join("\n"));
    return res;
  };

const TaskInput = {
  agent: z.string(),
  task: z.string().min(1).describe("Complete, self-contained instructions, including file paths and acceptance criteria."),
  build_on: z.string().optional().describe("task_id of an earlier task whose changes this task should start from."),
};

/** Told when yxu tools start and end (background compaction during a run, see MidRunCompactor). */
export interface ToolWatch {
  toolStart(): void;
  toolEnd(tool: string, text: string): void;
}

export function createYxuServer(ops: TaskOps, watch?: ToolWatch) {
  const { cfg, allowed } = ops;
  const { concurrency } = cfg.settings;
  const agentDesc = `Agent name: one of ${allowed.join(", ")}, or a subagent you spawned with spawn_agent`;

  const listAgents = tool(
    "list_agents",
    "List the subagents you can delegate to, with their CLI, model and description.",
    {},
    async () => {
      const lines = allowed.map((name) => {
        const a = cfg.agents[name]!;
        return `- ${name}: ${a.cli}${a.model ? ` / ${a.model}` : ""}${a.permission === "plan" ? " (read-only: its summary is the answer, no changes)" : ""}${a.description ? ` — ${a.description}` : ""}`;
      });
      const verify = cfg.settings.verify ? `\nDefault verify command: \`${cfg.settings.verify}\`` : "";
      const spawned = [...ops.session.spawned].map(([n, a]) => `- ${n}: ${a.cli} / ${a.model}${a.permission === "plan" ? " (read-only)" : ""} — ${a.description} (spawned)`);
      const pool = spawnPool(cfg);
      const spawn = cfg.spawn.enabled
        ? `\n\nYou can spawn up to ${Math.max(0, cfg.spawn.max - ops.session.spawned.size)} more with spawn_agent, from these providers and models the user allowed:\n${Object.entries(pool).map(([c, m]) => `- ${c}: ${m.join(", ")}`).join("\n") || "(none)"}`
        : "";
      return text(`${[...lines, ...spawned].join("\n")}\n\nUp to ${concurrency} subagents run at the same time.${verify}${spawn}`);
    },
  );

  const spawnAgent = tool(
    "spawn_agent",
    "Create a subagent for this session on a provider and model the user allowed (list_agents shows the pool), with a role you write. " +
      "Use it when no configured agent fits a task: a stronger or cheaper model, a specialist (e.g. a security reviewer, a migration writer). " +
      "Then delegate to it by name like any agent. Spawning again with the same name replaces its definition.",
    {
      name: z.string().describe("Lowercase name, e.g. sql-migrator"),
      provider: z.string().describe("The agent CLI: one of the pool's providers (commandcode, opencode, claude, …)"),
      model: z.string().describe("One of the models the pool lists for that provider"),
      role: z.string().min(3).describe("What it is for, one line (shown to the user)"),
      instructions: z.string().optional().describe("Its role prompt, put before every task it gets"),
      read_only: z.boolean().optional().describe("It reports and changes nothing (reviewers, explorers)"),
    },
    safe(async ({ name, provider, model, role, instructions, read_only }) => {
      const def = ops.spawn({ name, cli: provider, model, role, instructions, readOnly: read_only });
      return text(`Spawned ${name}: ${def.cli} / ${def.model}${def.permission === "plan" ? " (read-only)" : ""}. Delegate to it with agent "${name}".`);
    }),
  );

  const delegate = tool(
    "delegate",
    "Run one coding task with a subagent in an isolated git worktree. Blocks until the subagent finishes. " +
      "Returns status, the subagent's summary, changed files, and the diff. Task text must be self-contained: " +
      "the subagent cannot see this conversation. Use build_on to start from an earlier task's result " +
      "(for dependent tasks or fix-ups); otherwise the task starts from the user's current HEAD.",
    { ...TaskInput, agent: z.string().describe(agentDesc) },
    watched(watch, "delegate", async ({ agent, task, build_on }) => text(ops.format(await ops.delegate(agent, task, build_on)))),
  );

  const delegateParallel = tool(
    "delegate_parallel",
    `Run several INDEPENDENT tasks at once, each in its own worktree (up to ${concurrency} concurrently, the rest queue). ` +
      "Use it when tasks touch different files and don't depend on each other. Afterwards, call combine " +
      "to merge the successful results into one task the user can apply.",
    { tasks: z.array(z.object({ ...TaskInput, agent: z.string().describe(agentDesc) })).min(2).max(12) },
    watched(watch, "delegate_parallel", async ({ tasks }) => {
      const settled = await ops.delegateMany(tasks.map((t) => ({ agent: t.agent, task: t.task, buildOn: t.build_on })));
      const parts = settled.map((s, i) =>
        s.status === "fulfilled"
          ? `## [${i + 1}] ${tasks[i]!.agent}\n${ops.format(s.value)}`
          : `## [${i + 1}] ${tasks[i]!.agent}\nstatus: failed\nerror: ${(s.reason as Error).message}`,
      );
      const ok = settled.filter((s) => s.status === "fulfilled" && s.value.ok).length;
      return text(`${ok}/${tasks.length} succeeded.\n\n${parts.join("\n\n")}`);
    }),
  );

  const combine = tool(
    "combine",
    "Merge the results of several tasks (e.g. from delegate_parallel) into ONE new task branch starting from the " +
      "user's HEAD. Merge conflicts are resolved by the resolver agent if given (or the configured default); " +
      "otherwise a conflict fails and lists the files. Returns the combined task_id and diff. " +
      "Review it, and if needed delegate fixes with build_on=<combined task_id>.",
    {
      task_ids: z.array(z.string()).min(2),
      resolver: z.string().optional().describe(`Agent to resolve conflicts. One of: ${allowed.join(", ")}`),
    },
    watched(watch, "combine", async ({ task_ids, resolver }) => {
      const r = await ops.combine(task_ids, resolver);
      return text(ops.format(r, r.conflicts ? [`conflicts: ${r.conflicts.join(", ")}`] : []));
    }),
  );

  const verify = tool(
    "verify",
    "Run a check command (tests, build, lint) inside a task's worktree and return pass/fail plus the output tail. " +
      `Defaults to ${cfg.settings.verify ? `\`${cfg.settings.verify}\`` : "settings.verify (not configured; pass command)"}. ` +
      "Always verify the final task before reporting.",
    {
      task_id: z.string().describe("Task whose result to check."),
      command: z.string().optional().describe("Shell command to run instead of the default."),
    },
    watched(watch, "verify", async ({ task_id, command }) => text(ops.formatVerify(await ops.verify(task_id, command)))),
  );

  const getDiff = tool(
    "get_diff",
    "Get the full diff of a task. With cumulative=true, the diff from the user's HEAD including everything it was built on.",
    { task_id: z.string(), cumulative: z.boolean().optional() },
    safe(async ({ task_id, cumulative }) => text(ops.diff(task_id, cumulative) || "(no changes)")),
  );

  const discard = tool(
    "discard",
    "Throw away a task's changes (deletes its worktree and branch). Use for failed, rejected, or superseded work " +
      "(e.g. parallel tasks after you have combined them).",
    { task_id: z.string() },
    safe(async ({ task_id }) => {
      ops.discard(task_id);
      return text(`Discarded ${task_id}.`);
    }),
  );

  const findCode = tool(
    "find_code",
    "Search the repo map (files, their symbols with line numbers, tests, imports) for what a query names. Instant and free: " +
      "use it to find where something lives before reading files or delegating discovery.",
    { query: z.string().min(2).describe("Names, words or paths, e.g. 'validateConfig compact window' or 'login session cookie'") },
    safe(async ({ query }) => {
      const map = loadRepoMap(ops.root);
      if (!map) return text("No repo map yet (it is built at the start of a run); read the files instead.");
      const slice = mapSlice(map, query, { chars: 3000, noOverview: true });
      return text(slice.includes("Likely relevant") ? slice : `Nothing in the repo map matches "${query}". Try other names, or Grep.`);
    }),
  );

  const runInCheckout = tool(
    "run_in_checkout",
    "Run a shell command in the USER'S OWN checkout (not a task worktree) after the user approves it: repository chores they ask for, " +
      "such as git add / commit / push / pull / stash / switch, or installing dependencies. Read-only git commands (status, diff, log…) run without asking. " +
      "Never use it to change code (delegate that), never force-push or rewrite pushed history, and never stage secrets. One step per call.",
    {
      command: z.string().min(1).describe("The shell command, run from the repository root"),
      reason: z.string().optional().describe("One line the user sees when approving, e.g. 'commit everything except tasks/coder-zero-to-production'"),
    },
    safe(async ({ command, reason }) => {
      const r = await ops.checkout(command, reason);
      if (r.denied) return text(`Not run (${r.denied}): \`${command}\`. Don't retry it; tell the user, or give them the command to run themselves.`);
      const v = r.result!;
      return text(`\`${command}\` ${v.ok ? "succeeded" : v.timedOut ? "timed out" : `failed (exit ${v.exitCode})`} in ${(v.durationMs / 1000).toFixed(1)}s\n${v.output.slice(-6000) || "(no output)"}`);
    }),
  );

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "0.3.0",
    tools: [listAgents, spawnAgent, delegate, delegateParallel, combine, verify, getDiff, discard, findCode, runInCheckout],
  });
}
