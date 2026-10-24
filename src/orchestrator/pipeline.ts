import { z } from "zod";
import type { Config, Step, Workflow } from "../config.ts";
import { Session, TaskOps } from "../ops.ts";
import { newTaskId } from "../runner.ts";
import type { TaskResult } from "../types.ts";
import { askOrchestrator, sessionPath, type OrchestratorRender, type RunOutcome } from "./run.ts";

const PlanOutput = z.object({
  summary: z.string().describe("One paragraph: the approach."),
  tasks: z
    .array(
      z.object({
        title: z.string().describe("Short label, under 60 chars."),
        task: z.string().describe("Complete, self-contained instructions for a coding subagent."),
        agent: z.string().optional().describe("Preferred agent name, if one fits better than the step default."),
      }),
    )
    .min(1),
});

const ReviewOutput = z.object({
  approved: z.boolean().describe("True if the change fully achieves the goal and is correct."),
  summary: z.string().describe("Short assessment."),
  fixes: z
    .array(
      z.object({
        task: z.string().describe("Self-contained fix instructions: what is wrong, where, and what to change."),
        agent: z.string().optional(),
      }),
    )
    .describe("Fixes to delegate when not approved; empty when approved."),
});

interface StepState {
  summary: string;
  output: string;
  plan?: z.infer<typeof PlanOutput>;
}

/** Fill {{goal}}, {{<step>.summary}}, {{<step>.output}} placeholders. */
export function renderTemplate(tpl: string, goal: string, ctx: Record<string, StepState>): string {
  return tpl.replace(/\{\{\s*([\w-]+)(?:\.(summary|output))?\s*\}\}/g, (_, key: string, field?: "summary" | "output") => {
    if (key === "goal" && !field) return goal;
    const s = ctx[key];
    return s ? s[field ?? "summary"] : "";
  });
}

class PipelineError extends Error {}

export async function runPipeline(opts: {
  goal: string;
  cfg: Config;
  workflow: Workflow & { name: string };
  root: string;
  render: OrchestratorRender;
  abort: AbortController;
  /** Override the orchestrator model call (tests). */
  askImpl?: typeof askOrchestrator;
  /** Reuse a task session across turns (interactive UIs). */
  session?: Session;
}): Promise<RunOutcome> {
  const { goal, cfg, workflow, root, render, abort } = opts;
  const steps = workflow.steps ?? [];
  const session = opts.session ?? new Session();
  const runId = `run-${newTaskId()}`;
  const ops = new TaskOps(cfg, root, session, {
    allowedAgents: workflow.allowed_agents,
    signal: abort.signal,
    hooks: render.hooks,
  });
  const ctx: Record<string, StepState> = {};
  const log: string[] = [];
  let head: string | undefined;
  let costUsd = 0;
  let ok = true;

  const agentList = ops.allowed
    .map((n) => `- ${n}: ${cfg.agents[n]!.cli}/${cfg.agents[n]!.model ?? "default"}${cfg.agents[n]!.description ? ` — ${cfg.agents[n]!.description}` : ""}`)
    .join("\n");

  const ask = async <T extends z.ZodType>(system: string, prompt: string, schema: T) => {
    const budget = cfg.orchestrator.max_budget_usd;
    if (budget !== undefined && costUsd >= budget) throw new PipelineError(`orchestrator budget $${budget} used up`);
    const r = await (opts.askImpl ?? askOrchestrator)({ cfg, root, abort, system, prompt, schema, render });
    costUsd += r.costUsd;
    return r.value;
  };

  /** Advance head to a task's result if it produced changes. */
  const advance = (r: TaskResult) => {
    if (r.ok && r.branch) head = r.taskId;
  };

  const pickAgent = (preferred: string | undefined, fallback: string) =>
    preferred && ops.allowed.includes(preferred) && cfg.agents[preferred] ? preferred : fallback;

  async function runStep(step: Step): Promise<StepState> {
    switch (step.type) {
      case "plan": {
        const plan = await ask(
          `# You are the yxu planner
Break the user's goal into at most ${step.max_tasks} coding tasks for subagents.
- Tasks run IN PARALLEL in separate git worktrees and are merged afterwards, so make them
  independent and avoid two tasks editing the same file. Prefer fewer, larger tasks over
  tasks that would conflict.
- Each task must be self-contained (subagents cannot see the goal or each other): name files,
  behavior, and how to check it.
- Read the code first so the tasks are accurate.

Available agents:
${agentList}
${workflow.instructions ? `\nWorkflow instructions:\n${workflow.instructions}` : ""}${step.instructions ? `\nStep instructions:\n${step.instructions}` : ""}`,
          `Goal: ${goal}`,
          PlanOutput,
        );
        plan.tasks = plan.tasks.slice(0, step.max_tasks);
        const lines = plan.tasks.map((t, i) => `${i + 1}. ${t.title}`);
        return { summary: plan.summary, output: lines.join("\n"), plan };
      }

      case "delegate": {
        if (!step.for_each) {
          const task = renderTemplate(step.prompt!, goal, ctx);
          const r = await ops.delegate(step.agent, task, head);
          if (!r.ok) throw new PipelineError(`${step.agent} failed: ${r.error}`);
          advance(r);
          return { summary: r.summary, output: ops.format(r) };
        }

        const plan = ctx[step.for_each]?.plan;
        if (!plan) throw new PipelineError(`no plan from step "${step.for_each}"`);
        const items = plan.tasks.map((t) => ({
          agent: pickAgent(t.agent, step.agent),
          task: `${t.task}\n\n(Overall goal, for context: ${goal})`,
          buildOn: head,
        }));
        const settled =
          items.length === 1
            ? [await ops.delegate(items[0]!.agent, items[0]!.task, head).then(
                (value) => ({ status: "fulfilled" as const, value }),
                (reason) => ({ status: "rejected" as const, reason }),
              )]
            : await ops.delegateMany(items);

        const done: TaskResult[] = [];
        const failed: string[] = [];
        settled.forEach((s, i) => {
          const title = plan.tasks[i]!.title;
          if (s.status === "fulfilled" && s.value.ok) done.push(s.value);
          else failed.push(`${title}: ${s.status === "fulfilled" ? s.value.error : (s.reason as Error).message}`);
        });
        const changed = done.filter((r) => r.branch);
        if (!done.length) throw new PipelineError(`all ${items.length} tasks failed:\n${failed.join("\n")}`);

        if (changed.length === 1) advance(changed[0]!);
        if (changed.length > 1) {
          const c = await ops.combine(changed.map((r) => r.taskId));
          if (!c.ok) throw new PipelineError(`combine failed: ${c.error}`);
          advance(c);
          // Parents live on inside the combined task; drop their branches.
          for (const r of changed) ops.discard(r.taskId);
        }
        const summary =
          `${done.length}/${items.length} tasks succeeded` + (failed.length ? `; failed:\n${failed.join("\n")}` : ".");
        return { summary, output: done.map((r) => `- ${r.summary.split("\n")[0]}`).join("\n") };
      }

      case "verify": {
        const command = step.command ?? cfg.settings.verify!;
        for (let round = 1; ; round++) {
          const v = await ops.verify(head, command);
          const output = ops.formatVerify(v);
          if (v.ok) return { summary: `\`${command}\` passed${round > 1 ? ` after ${round - 1} fix(es)` : ""}`, output };
          if (!step.fix_agent || round > step.max_rounds) {
            throw new PipelineError(`\`${command}\` still failing after ${round - 1} fix(es):\n${v.output.slice(-1500)}`);
          }
          render.step?.({ id: step.id, type: "fix", index: round, total: step.max_rounds, note: "verify failed, delegating a fix" });
          const fix = await ops.delegate(
            step.fix_agent,
            `The check \`${command}\` fails. Make it pass by fixing the code (do not delete or weaken tests ` +
              `unless they are clearly wrong). Overall goal, for context: ${goal}\n\nFailure output:\n${v.output}`,
            head,
          );
          if (!fix.ok) throw new PipelineError(`fix by ${step.fix_agent} failed: ${fix.error}`);
          advance(fix);
        }
      }

      case "review": {
        for (let round = 1; ; round++) {
          if (!head) return { summary: "nothing to review (no changes)", output: "" };
          const diff = ops.diff(head, true);
          const max = cfg.settings.max_diff_chars * 3;
          const verifyNote = cfg.settings.verify ? ops.formatVerify(await ops.verify(head)) : "(no verify command configured)";
          const review = await ask(
            `# You are the yxu reviewer
Judge whether the change achieves the goal correctly and completely. You may read the code in
the task's worktree at .yxu/worktrees/${head}/ for context. Be strict about correctness and
missing requirements, lenient about style. If not approved, list concrete, self-contained fixes.
${workflow.instructions ? `\nWorkflow instructions:\n${workflow.instructions}` : ""}${step.instructions ? `\nStep instructions:\n${step.instructions}` : ""}`,
            `Goal: ${goal}\n\nVerification:\n${verifyNote}\n\nCumulative diff:\n${
              diff.length > max ? `${diff.slice(0, max)}\n… [truncated]` : diff
            }`,
            ReviewOutput,
          );
          render.assistantText(`review round ${round}: ${review.approved ? "approved" : "changes requested"} — ${review.summary}`);
          if (review.approved || !review.fixes.length) {
            return { summary: review.approved ? `approved: ${review.summary}` : `not approved: ${review.summary}`, output: review.summary };
          }
          if (round > step.max_rounds) {
            ok = false;
            return { summary: `not approved after ${step.max_rounds} round(s): ${review.summary}`, output: review.summary };
          }
          for (const f of review.fixes) {
            const r = await ops.delegate(pickAgent(f.agent, step.fix_agent), `${f.task}\n\n(Overall goal, for context: ${goal})`, head);
            if (!r.ok) throw new PipelineError(`fix failed: ${r.error}`);
            advance(r);
          }
        }
      }
    }
  }

  for (const [i, step] of steps.entries()) {
    if (abort.signal.aborted) {
      ok = false;
      log.push("cancelled");
      break;
    }
    render.step?.({ id: step.id, type: step.type, index: i + 1, total: steps.length });
    try {
      ctx[step.id] = await runStep(step);
      log.push(`✓ ${step.id}: ${ctx[step.id]!.summary}`);
      if (step.type === "plan") render.assistantText(`plan: ${ctx[step.id]!.summary}\n${ctx[step.id]!.output}`);
    } catch (e) {
      ok = false;
      log.push(`✗ ${step.id}: ${(e as Error).message}`);
      break;
    }
  }

  const finalText = [
    `Pipeline "${workflow.name}" ${ok ? "completed" : "did not complete"}.`,
    ...log,
    head ? `\nResult task: ${head}` : "\nNo changes were produced.",
  ].join("\n");

  session.save(sessionPath(root, runId), { runId, goal, workflow, orchestrator: cfg.orchestrator, ok, costUsd, finalText, head });
  return { runId, ok, finalText, costUsd, session, headTaskId: head, cancelled: abort.signal.aborted };
}
