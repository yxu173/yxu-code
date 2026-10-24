import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TaskOps } from "../ops.ts";

export { Session, type OpsHooks as ToolHooks } from "../ops.ts";

export const SERVER_NAME = "yxu";
export const TOOL_NAMES = ["list_agents", "delegate", "delegate_parallel", "combine", "verify", "get_diff", "discard"].map(
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

const TaskInput = {
  agent: z.string(),
  task: z.string().min(1).describe("Complete, self-contained instructions, including file paths and acceptance criteria."),
  build_on: z.string().optional().describe("task_id of an earlier task whose changes this task should start from."),
};

export function createYxuServer(ops: TaskOps) {
  const { cfg, allowed } = ops;
  const { concurrency } = cfg.settings;
  const agentDesc = `Agent name. One of: ${allowed.join(", ")}`;

  const listAgents = tool(
    "list_agents",
    "List the subagents you can delegate to, with their CLI, model and description.",
    {},
    async () => {
      const lines = allowed.map((name) => {
        const a = cfg.agents[name]!;
        return `- ${name}: ${a.cli}${a.model ? ` / ${a.model}` : ""}${a.description ? ` — ${a.description}` : ""}`;
      });
      const verify = cfg.settings.verify ? `\nDefault verify command: \`${cfg.settings.verify}\`` : "";
      return text(`${lines.join("\n")}\n\nUp to ${concurrency} subagents run at the same time.${verify}`);
    },
  );

  const delegate = tool(
    "delegate",
    "Run one coding task with a subagent in an isolated git worktree. Blocks until the subagent finishes. " +
      "Returns status, the subagent's summary, changed files, and the diff. Task text must be self-contained: " +
      "the subagent cannot see this conversation. Use build_on to start from an earlier task's result " +
      "(for dependent tasks or fix-ups); otherwise the task starts from the user's current HEAD.",
    { ...TaskInput, agent: z.string().describe(agentDesc) },
    safe(async ({ agent, task, build_on }) => text(ops.format(await ops.delegate(agent, task, build_on)))),
  );

  const delegateParallel = tool(
    "delegate_parallel",
    `Run several INDEPENDENT tasks at once, each in its own worktree (up to ${concurrency} concurrently, the rest queue). ` +
      "Use it when tasks touch different files and don't depend on each other. Afterwards, call combine " +
      "to merge the successful results into one task the user can apply.",
    { tasks: z.array(z.object({ ...TaskInput, agent: z.string().describe(agentDesc) })).min(2).max(12) },
    safe(async ({ tasks }) => {
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
    safe(async ({ task_ids, resolver }) => {
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
    safe(async ({ task_id, command }) => text(ops.formatVerify(await ops.verify(task_id, command)))),
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

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "0.3.0",
    tools: [listAgents, delegate, delegateParallel, combine, verify, getDiff, discard],
  });
}
