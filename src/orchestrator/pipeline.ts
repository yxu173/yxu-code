import { z } from "zod";
import type { Config, Step, Workflow } from "../config.ts";
import { condition, render, type Scope } from "../expr.ts";
import { branchFor } from "../git.ts";
import { Session, TaskOps } from "../ops.ts";
import { plannerBase, prompt, reviewerBase } from "../prompts.ts";
import { newTaskId } from "../runner.ts";
import type { TaskResult } from "../types.ts";
import { guard } from "../trust.ts";
import { runVerify } from "../verify.ts";
import { askProvider, type AskFn } from "./providers.ts";
import { sessionPath, type OrchestratorRender, type RunOutcome } from "./run.ts";

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

/** What a step leaves behind for later steps: {{<id>.ok}}, {{<id>.output}}, … */
export interface StepResult {
  ok: boolean;
  summary: string;
  output: string;
  skipped?: boolean;
  exit_code?: number | null;
  /** plan steps: the planned tasks. */
  tasks?: z.infer<typeof PlanOutput>["tasks"];
  /** review steps. */
  approved?: boolean;
  /** workflow steps: the called workflow's outputs. */
  outputs?: Record<string, string>;
  /** loop steps: rounds run. */
  rounds?: number;
}

/** Fill {{goal}}, {{<step>.summary}}, {{<step>.output}} … placeholders (see expr.ts). */
export function renderTemplate(tpl: string, goal: string, ctx: Record<string, Partial<StepResult>>): string {
  return render(tpl, { ...ctx, goal });
}

class StepFailed extends Error {}
class Stopped extends Error {}

const MAX_DEPTH = 5;

/** Declared inputs with defaults applied; unknown or missing required inputs are errors. */
export function resolveInputs(workflow: Workflow & { name: string }, given: Record<string, string> = {}): Record<string, unknown> {
  const decl = workflow.inputs ?? {};
  const unknown = Object.keys(given).filter((k) => !(k in decl));
  if (unknown.length) {
    const takes = Object.keys(decl);
    throw new Error(`workflow "${workflow.name}" has no input ${unknown.map((k) => `"${k}"`).join(", ")}${takes.length ? ` (inputs: ${takes.join(", ")})` : " (it takes no inputs)"}`);
  }
  const out: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [k, d] of Object.entries(decl)) {
    const v = given[k];
    if (v === undefined) {
      if (d.default !== undefined) out[k] = d.default;
      else if (d.required !== false) missing.push(d.description ? `${k} (${d.description})` : k);
      continue;
    }
    // Strings from the command line take the type of the default.
    out[k] = typeof d.default === "number" ? Number(v) : typeof d.default === "boolean" ? v === "true" || v === "1" || v === "yes" : v;
  }
  if (missing.length) throw new Error(`workflow "${workflow.name}" needs input ${missing.join(", ")}; pass --input name=value`);
  return out;
}

/** Number of steps, nested ones included (for "step 3/7" progress). */
function flatten(steps: Step[]): Step[] {
  return steps.flatMap((s) => [s, ...(s.type === "parallel" || s.type === "loop" ? flatten(s.steps) : [])]);
}

export interface PipelineOptions {
  goal: string;
  cfg: Config;
  workflow: Workflow & { name: string };
  root: string;
  render: OrchestratorRender;
  abort: AbortController;
  /** Values for the workflow's declared inputs. */
  inputs?: Record<string, string>;
  /** Ask the user at a gate step; resolve true to continue. Without it, gates fail. */
  gate?: (message: string, stepId: string) => Promise<boolean>;
  /** Override the orchestrator model call (tests). */
  askImpl?: AskFn;
  /** Reuse a task session across turns (interactive UIs). */
  session?: Session;
}

export async function runPipeline(opts: PipelineOptions): Promise<RunOutcome> {
  const { cfg, workflow, root, render: ui, abort } = opts;
  const session = opts.session ?? new Session();
  const runId = `run-${newTaskId()}`;
  const ops = new TaskOps(cfg, root, session, {
    allowedAgents: workflow.allowed_agents,
    signal: abort.signal,
    hooks: ui.hooks,
    ask: ui.ask,
  });
  const log: string[] = [];
  let costUsd = 0;
  let softFail = false;

  const agentList = ops.allowed
    .map((n) => `- ${n}: ${cfg.agents[n]!.cli}/${cfg.agents[n]!.model ?? "default"}${cfg.agents[n]!.permission === "plan" ? " (read-only: reports, makes no changes)" : ""}${cfg.agents[n]!.description ? ` — ${cfg.agents[n]!.description}` : ""}`)
    .join("\n");

  const ask = async <T extends z.ZodType>(system: string, user: string, schema: T, head?: string) => {
    const budget = cfg.orchestrator.max_budget_usd;
    if (budget !== undefined && costUsd >= budget) throw new StepFailed(`orchestrator budget $${budget} used up`);
    const r = await (opts.askImpl ?? askProvider)({ cfg, root, abort, system, prompt: user, schema, render: ui, head });
    costUsd += r.costUsd;
    return r.value;
  };

  const pickAgent = (preferred: string | undefined, fallback: string) =>
    preferred && ops.allowed.includes(preferred) && cfg.agents[preferred] ? preferred : fallback;

  /** Where the work stands: the task later steps build on. */
  type Cursor = { head?: string };
  /** One workflow invocation (the top one, or one called by a `workflow` step). */
  interface Frame {
    workflow: Workflow & { name: string };
    goal: string;
    inputs: Record<string, unknown>;
    results: Record<string, StepResult>;
    depth: number;
    positions: Map<Step, number>;
    total: number;
  }

  const scopeOf = (f: Frame, cur: Cursor): Scope => ({
    ...f.results,
    goal: f.goal,
    inputs: f.inputs,
    head: cur.head ? { id: cur.head, branch: branchFor(cur.head) } : undefined,
    settings: { verify: cfg.settings.verify },
  });

  const newFrame = (wf: Workflow & { name: string }, goal: string, inputs: Record<string, unknown>, depth: number): Frame => {
    const all = flatten(wf.steps ?? []);
    return { workflow: wf, goal, inputs, results: {}, depth, positions: new Map(all.map((s, i) => [s, i + 1])), total: all.length };
  };

  /** Fold several branches that grew from the same start into one head. */
  async function join(cur: Cursor, start: string | undefined, heads: (string | undefined)[]) {
    const changed = [...new Set(heads.filter((h): h is string => !!h && h !== start))];
    if (changed.length === 1) cur.head = changed[0];
    if (changed.length > 1) {
      const c = await ops.combine(changed);
      if (!c.ok) throw new StepFailed(`combine failed: ${c.error}`);
      cur.head = c.taskId;
      for (const id of changed) ops.discard(id); // their commits live on inside the combined task
    }
  }

  async function runSteps(steps: Step[], f: Frame, cur: Cursor) {
    for (const step of steps) await runOne(step, f, cur);
  }

  async function runOne(step: Step, f: Frame, cur: Cursor): Promise<void> {
    if (abort.signal.aborted) throw new Stopped("cancelled");
    const scope = scopeOf(f, cur);
    const pad = "  ".repeat(f.depth);
    const index = f.positions.get(step) ?? 0;
    if ((step.if !== undefined && !condition(step.if, scope)) || (step.unless !== undefined && condition(step.unless, scope))) {
      f.results[step.id] = { ok: true, skipped: true, summary: "skipped", output: "" };
      ui.step?.({ id: step.id, type: step.type, index, total: f.total, note: "skipped" });
      log.push(`${pad}○ ${step.id}: skipped`);
      return;
    }
    ui.step?.({ id: step.id, type: step.type, index, total: f.total, note: step.description });
    let res: StepResult;
    try {
      res = await exec(step, f, cur);
    } catch (e) {
      if (e instanceof Stopped || abort.signal.aborted) throw e;
      const msg = (e as Error).message;
      f.results[step.id] = { ok: false, summary: msg, output: msg };
      log.push(`${pad}✗ ${step.id}: ${msg}`);
      if (step.continue_on_error) return;
      throw e instanceof StepFailed ? e : new StepFailed(msg);
    }
    f.results[step.id] = res;
    log.push(`${pad}${res.ok ? "✓" : "✗"} ${step.id}: ${res.summary.split("\n")[0]}`);
    if (step.type === "plan") ui.assistantText(`plan: ${res.summary}\n${res.output}`);
  }

  async function exec(step: Step, f: Frame, cur: Cursor): Promise<StepResult> {
    const scope = scopeOf(f, cur);
    const { goal } = f;
    const wfInstructions = f.workflow.instructions ? `\nWorkflow instructions:\n${f.workflow.instructions}` : "";
    switch (step.type) {
      case "plan": {
        const plan = await ask(
          `${prompt(root, "planner", plannerBase(step.max_tasks), { max_tasks: step.max_tasks, goal })}

Available agents:
${agentList}
${wfInstructions}${step.instructions ? `\nStep instructions:\n${render(step.instructions, scope)}` : ""}`,
          `Goal: ${goal}`,
          PlanOutput,
        );
        plan.tasks = plan.tasks.slice(0, step.max_tasks);
        return { ok: true, summary: plan.summary, output: plan.tasks.map((t, i) => `${i + 1}. ${t.title}`).join("\n"), tasks: plan.tasks };
      }

      case "delegate": {
        if (!step.for_each) {
          const r = await ops.delegate(step.agent, render(step.prompt!, scope), cur.head);
          if (!r.ok) throw new StepFailed(`${step.agent} failed: ${r.error}`);
          if (r.branch) cur.head = r.taskId;
          return { ok: true, summary: r.summary, output: ops.format(r) };
        }
        const tasks = f.results[step.for_each]?.tasks;
        if (!tasks) throw new StepFailed(`no plan from step "${step.for_each}"`);
        const start = cur.head;
        const items = tasks.map((t) => ({
          agent: pickAgent(t.agent, step.agent),
          task: `${t.task}\n\n(Overall goal, for context: ${goal})`,
          buildOn: start,
        }));
        const settled =
          items.length === 1
            ? [
                await ops.delegate(items[0]!.agent, items[0]!.task, start).then(
                  (value) => ({ status: "fulfilled" as const, value }),
                  (reason) => ({ status: "rejected" as const, reason }),
                ),
              ]
            : await ops.delegateMany(items);
        const done: TaskResult[] = [];
        const failed: string[] = [];
        settled.forEach((s, i) => {
          const title = tasks[i]!.title;
          if (s.status === "fulfilled" && s.value.ok) done.push(s.value);
          else failed.push(`${title}: ${s.status === "fulfilled" ? s.value.error : (s.reason as Error).message}`);
        });
        if (!done.length) throw new StepFailed(`all ${items.length} tasks failed:\n${failed.join("\n")}`);
        await join(cur, start, done.filter((r) => r.branch).map((r) => r.taskId));
        const summary = `${done.length}/${items.length} tasks succeeded` + (failed.length ? `; failed:\n${failed.join("\n")}` : ".");
        return { ok: true, summary, output: done.map((r) => `- ${r.summary.split("\n")[0]}`).join("\n") };
      }

      case "verify": {
        const command = step.command ? render(step.command, scope, { shell: true }) : cfg.settings.verify!;
        guard(cfg, step.command ? `workflows.${f.workflow.name}` : "settings.verify", `\`${command}\` (workflow ${f.workflow.name}, step ${step.id})`);
        for (let round = 1; ; round++) {
          const v = await ops.verify(cur.head, command);
          const output = ops.formatVerify(v);
          if (v.ok) return { ok: true, exit_code: v.exitCode, summary: `\`${command}\` passed${round > 1 ? ` after ${round - 1} fix(es)` : ""}`, output };
          if (!step.fix_agent || round > step.max_rounds) {
            throw new StepFailed(`\`${command}\` still failing after ${round - 1} fix(es):\n${v.output.slice(-1500)}`);
          }
          ui.step?.({ id: step.id, type: "fix", index: round, total: step.max_rounds, note: "verify failed, delegating a fix" });
          const fix = await ops.delegate(
            step.fix_agent,
            `The check \`${command}\` fails. Make it pass by fixing the code (do not delete or weaken tests ` +
              `unless they are clearly wrong). Overall goal, for context: ${goal}\n\nFailure output:\n${v.output}`,
            cur.head,
          );
          if (!fix.ok) throw new StepFailed(`fix by ${step.fix_agent} failed: ${fix.error}`);
          if (fix.branch) cur.head = fix.taskId;
        }
      }

      case "review": {
        for (let round = 1; ; round++) {
          if (!cur.head) return { ok: true, approved: true, summary: "nothing to review (no changes)", output: "" };
          const diff = ops.diff(cur.head, true);
          const max = cfg.settings.max_diff_chars * 3;
          const verifyNote = cfg.settings.verify ? ops.formatVerify(await ops.verify(cur.head)) : "(no verify command configured)";
          const review = await ask(
            `${prompt(root, "reviewer", reviewerBase(cur.head), { head: cur.head, goal })}
${wfInstructions}${step.instructions ? `\nStep instructions:\n${render(step.instructions, scope)}` : ""}`,
            `Goal: ${goal}\n\nVerification:\n${verifyNote}\n\nCumulative diff:\n${diff.length > max ? `${diff.slice(0, max)}\n… [truncated]` : diff}`,
            ReviewOutput,
            cur.head,
          );
          ui.assistantText(`review round ${round}: ${review.approved ? "approved" : "changes requested"} — ${review.summary}`);
          if (review.approved || !review.fixes.length) {
            return {
              ok: review.approved,
              approved: review.approved,
              summary: review.approved ? `approved: ${review.summary}` : `not approved: ${review.summary}`,
              output: review.summary,
            };
          }
          if (round > step.max_rounds) {
            softFail = true;
            return { ok: false, approved: false, summary: `not approved after ${step.max_rounds} round(s): ${review.summary}`, output: review.summary };
          }
          for (const fx of review.fixes) {
            const r = await ops.delegate(pickAgent(fx.agent, step.fix_agent), `${fx.task}\n\n(Overall goal, for context: ${goal})`, cur.head);
            if (!r.ok) throw new StepFailed(`fix failed: ${r.error}`);
            if (r.branch) cur.head = r.taskId;
          }
        }
      }

      case "shell": {
        const command = render(step.command, scope, { shell: true });
        guard(cfg, `workflows.${f.workflow.name}`, `\`${command}\` (workflow ${f.workflow.name}, step ${step.id})`);
        const env: Record<string, string> = {
          YXU_GOAL: goal,
          YXU_REPO: root,
          YXU_WORKFLOW: f.workflow.name,
          ...(cur.head ? { YXU_HEAD: cur.head, YXU_HEAD_BRANCH: branchFor(cur.head) } : {}),
          ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, render(v, scope)])),
        };
        const timeoutMs = step.timeout ?? cfg.settings.verify_timeout;
        let v;
        if (step.in === "repo") {
          ui.hooks.onShellStart?.({ id: step.id, command });
          v = await runVerify(root, command, timeoutMs, abort.signal, env);
          ui.hooks.onShellEnd?.({ id: step.id, result: v });
        } else {
          const r = await ops.shell(step.id, command, cur.head, { timeoutMs, env });
          v = r.result;
          if (r.task) cur.head = r.task.taskId; // keep what it changed, even when it then failed
        }
        const summary = `\`${command.split("\n")[0]}\` ${v.ok ? "passed" : v.timedOut ? "timed out" : `failed (exit ${v.exitCode})`}`;
        if (!v.ok) throw new StepFailed(`${summary}\n${v.output.slice(-1500)}`);
        return { ok: true, exit_code: v.exitCode, summary, output: v.output };
      }

      case "gate": {
        const message = render(step.message, scope);
        if (!opts.gate) throw new StepFailed(`gate "${step.id}" needs your approval ("${message}"); run it in the interface or pass --yes`);
        if (!(await opts.gate(message, step.id))) throw new Stopped(`stopped at gate "${step.id}"`);
        return { ok: true, summary: "approved", output: message };
      }

      case "parallel": {
        const start = cur.head;
        const cursors = step.steps.map(() => ({ head: start }));
        const settled = await Promise.allSettled(step.steps.map((s, i) => runOne(s, f, cursors[i]!)));
        const stopped = settled.find((s) => s.status === "rejected" && s.reason instanceof Stopped);
        if (stopped) throw (stopped as PromiseRejectedResult).reason;
        await join(cur, start, cursors.map((c) => c.head));
        const failed = step.steps.filter((_, i) => settled[i]!.status === "rejected").map((s) => s.id);
        if (failed.length) throw new StepFailed(`${failed.length}/${step.steps.length} failed: ${failed.join(", ")}`);
        const ok = step.steps.filter((s) => f.results[s.id]?.ok).length;
        return { ok: true, summary: `${ok}/${step.steps.length} steps ok`, output: step.steps.map((s) => `${s.id}: ${f.results[s.id]?.summary ?? ""}`).join("\n") };
      }

      case "loop": {
        for (let round = 1; round <= step.max_rounds; round++) {
          if (round > 1) ui.step?.({ id: step.id, type: "loop", index: f.positions.get(step) ?? 0, total: f.total, note: `round ${round}/${step.max_rounds}` });
          await runSteps(step.steps, f, cur);
          if (step.until !== undefined && condition(step.until, scopeOf(f, cur))) {
            return { ok: true, rounds: round, summary: `done after ${round} round(s)`, output: "" };
          }
        }
        if (step.until === undefined) return { ok: true, rounds: step.max_rounds, summary: `ran ${step.max_rounds} round(s)`, output: "" };
        throw new StepFailed(`still not done after ${step.max_rounds} round(s) (until: ${step.until})`);
      }

      case "workflow": {
        if (f.depth + 1 > MAX_DEPTH) throw new StepFailed(`workflows nested more than ${MAX_DEPTH} deep`);
        const target = cfg.workflows[step.workflow];
        if (!target) throw new StepFailed(`unknown workflow "${step.workflow}"`);
        const wf = { ...target, name: step.workflow };
        const given = Object.fromEntries(Object.entries(step.inputs ?? {}).map(([k, v]) => [k, render(v, scope)]));
        const sub = newFrame(wf, step.goal ? render(step.goal, scope) : goal, resolveInputs(wf, given), f.depth + 1);
        await runSteps(wf.steps ?? [], sub, cur);
        const outputs = renderOutputs(wf, scopeOf(sub, cur));
        return {
          ok: true,
          outputs,
          summary: `workflow "${step.workflow}" completed`,
          output: Object.entries(outputs).map(([k, v]) => `${k}: ${v}`).join("\n"),
        };
      }
    }
  }

  const renderOutputs = (wf: Workflow, scope: Scope) =>
    Object.fromEntries(Object.entries(wf.outputs ?? {}).map(([k, tpl]) => [k, render(tpl, scope)]));

  const top = newFrame(workflow, opts.goal, resolveInputs(workflow, opts.inputs), 0);
  const cur: Cursor = {};
  let ok = true;
  let outputs: Record<string, string> = {};
  try {
    await runSteps(workflow.steps ?? [], top, cur);
    outputs = renderOutputs(workflow, scopeOf(top, cur));
  } catch (e) {
    ok = false;
    if (e instanceof Stopped || abort.signal.aborted) log.push(abort.signal.aborted ? "cancelled" : (e as Error).message);
  }
  if (softFail) ok = false;

  const outLines = Object.entries(outputs).map(([k, v]) => `- ${k}: ${v}`);
  const finalText = [
    `Pipeline "${workflow.name}" ${ok ? "completed" : "did not complete"}.`,
    ...log,
    ...(outLines.length ? ["", "Outputs:", ...outLines] : []),
    cur.head ? `\nResult task: ${cur.head}` : "\nNo changes were produced.",
  ].join("\n");

  session.save(sessionPath(root, runId), { runId, goal: opts.goal, workflow, orchestrator: cfg.orchestrator, ok, costUsd, finalText, head: cur.head, outputs });
  return { runId, ok, finalText, costUsd, session, headTaskId: cur.head, cancelled: abort.signal.aborted, outputs };
}
