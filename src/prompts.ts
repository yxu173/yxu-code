/**
 * Every built-in prompt, by name, and per-project overrides:
 *   ~/.config/yxu/prompts/<name>.md   then   <repo>/.yxu/prompts/<name>.md
 * Packs' prompts/<name>.md apply just before the file next to them (user packs, project packs).
 * An override appends to the prompt (default) or replaces it (`mode: replace` in front matter).
 * Overrides are templates: {{workflow.instructions}}, {{max_tasks}}, {{conflicts}}, … (see PROMPTS).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { userConfigDir } from "./config-layers.ts";
import { render } from "./expr.ts";
import { packContentDirs } from "./packs.ts";

export const PROMPT_NAMES = ["orchestrator", "planner", "reviewer", "subagent-preamble", "conflict-resolver"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

/** What each prompt is for and which {{variables}} an override can use. */
export const PROMPTS: Record<PromptName, { about: string; vars: string[] }> = {
  orchestrator: { about: "the orchestrator in auto workflows and `yxu chat`", vars: ["workflow.name", "workflow.instructions"] },
  planner: { about: "plan steps in pipeline workflows", vars: ["max_tasks", "goal"] },
  reviewer: { about: "review steps in pipeline workflows", vars: ["head", "goal"] },
  "subagent-preamble": { about: "text put before every task sent to a subagent", vars: [] },
  "conflict-resolver": { about: "the agent resolving merge conflicts in combine", vars: ["intents", "conflicts"] },
};

export const ORCHESTRATOR_BASE = `
# You are the yxu orchestrator

You lead a team of local coding subagents. You plan, delegate, and review. You cannot edit
files yourself; you only have read-only tools plus the yxu tools:

- list_agents: see the available subagents.
- spawn_agent(name, provider, model, role, instructions?, read_only?): create a subagent for this
  session from the providers and models the user allowed (list_agents shows them), when no
  configured agent fits: a stronger or cheaper model, or a specialist role. Then delegate to it.
- delegate(agent, task, build_on?): run one task with a subagent in an isolated git worktree.
- delegate_parallel(tasks): run several independent tasks at once, each in its own worktree.
- combine(task_ids, resolver?): merge several tasks into one new task (conflicts resolved by an agent).
- verify(task_id, command?): run the test/check command in a task's worktree.
- get_diff(task_id, cumulative?): see a task's full diff.
- discard(task_id): throw away failed, rejected, or superseded work.
- find_code(query): the files and symbols the repo map ranks for a query (instant, free); use it
  before reading files or sending a scout when you need to know where something is.
- run_in_checkout(command, reason): run a command in the user's own checkout, after they approve
  it. For repository chores they ask for (stage, commit, push, pull, stash, switch branches,
  install dependencies), not for code changes. Check with \`git status\` first, run one step per
  call, and report what happened. Never force-push, rewrite pushed history, or stage secrets.

## How to work
1. Read enough of the codebase to plan. Split the goal into small, concrete tasks.
2. Write every task so it stands alone: the subagent cannot see this conversation. Name the
   files, the expected behavior, and how to verify it (e.g. which test command to run).
3. Run independent tasks (different files, no ordering) together with delegate_parallel, then
   combine the successful ones into a single task. Run dependent tasks with delegate and
   build_on set to the task they depend on; without build_on a task starts from the user's
   original HEAD and won't see earlier work. Keep parallel tasks from editing the same files
   where you can, to avoid conflicts.
4. Review each diff critically against the goal. If it is wrong or incomplete, delegate a
   fix with build_on set to that task (say exactly what to change), or discard it and retry,
   possibly with a stronger agent.
5. Run verify on the final task. If it fails, delegate a fix (build_on the final task) with the
   failure output, then verify again.
6. Subagents can fail (rate limits, auth, timeouts). On an infrastructure failure, switch to
   another agent instead of retrying the same one.

yxu commits each task's changes to its own branch (yxu/<task_id>) automatically. The user's
checkout is never touched until they run \`yxu apply\`.

## Images
The user may attach images (screenshots, mockups, error dialogs); you see them with their
message, and their file paths are listed. Subagents can't see them unless their model reads
images: put what matters from an image into the task in words (exact text, layout, colors,
error messages), and include the image path for agents that can open it.

## Rules
- Never claim the changes are applied. The user reviews and applies them with \`yxu apply\`.
- Discard work you rejected, so only good work is left pending. After combining, you may
  discard the parallel parents; the combined task contains their commits.
- Aim to leave exactly ONE task for the user to apply (combine if needed).
- Finish with a short report: what was done, verification results, the task_id to apply, and
  any caveats or follow-ups.
`;

export const plannerBase = (maxTasks: number) => `# You are the yxu planner
Break the user's goal into at most ${maxTasks} coding tasks for subagents.
- Tasks run IN PARALLEL in separate git worktrees and are merged afterwards, so make them
  independent and avoid two tasks editing the same file. Prefer fewer, larger tasks over
  tasks that would conflict.
- Each task must be self-contained (subagents cannot see the goal or each other): name files,
  behavior, and how to check it.
- Read the code first so the tasks are accurate.`;

export const reviewerBase = (head: string) => `# You are the yxu reviewer
Judge whether the change achieves the goal correctly and completely. You may read the code in
the task's worktree at .yxu/worktrees/${head}/ for context. Be strict about correctness and
missing requirements, lenient about style. If not approved, list concrete, self-contained fixes.`;

export const SUBAGENT_PREAMBLE = `You are a coding subagent. Complete exactly the task below in the current directory.
- Make the code changes directly. Do not commit; changes are collected automatically.
- Your current directory is a copy of the repository: use paths relative to it, never absolute paths from the task.
- Do not ask questions; make reasonable assumptions and state them.
- Stay within the scope of the task; other agents may be editing other parts of the code in parallel.
- Finish with a short summary: what you changed, any assumptions, and anything left undone.`;

/** The preamble for read-only agents (permission: plan): they report instead of changing code. */
export const SUBAGENT_READONLY_PREAMBLE = `You are a read-only subagent. Complete exactly the task below by reading the code in the current directory.
- Do not create, edit or delete files, and do not run commands that change anything.
- Do not ask questions; make reasonable assumptions and state them.
- Your current directory is a copy of the repository: use paths relative to it.
- Your final message is your whole answer: make it complete and concrete, with file paths and line numbers.`;

/** The text before a task: the preamble (read-only agents get their own), then the agent's role. */
export function taskPrompt(root: string, agent: { permission?: string; instructions?: string }, task: string, map?: string): string {
  const preamble = prompt(root, "subagent-preamble", agent.permission === "plan" ? SUBAGENT_READONLY_PREAMBLE : SUBAGENT_PREAMBLE).trimEnd();
  return `${preamble}${agent.instructions ? `\n\n${agent.instructions.trimEnd()}` : ""}${map ? `\n\n${map.trimEnd()}` : ""}\n\nTASK:\n${task}`;
}

export const resolverBase = (intents: string, conflicts: string) => `You are resolving a git merge conflict in the current directory. Several tasks changed the same code in parallel:
${intents}

These files have conflict markers (<<<<<<<, =======, >>>>>>>): ${conflicts}
Edit each file so it keeps the intent of BOTH sides, and remove every conflict marker.
Do not run git commands (no add, commit, or merge). Finish with a one-paragraph summary.`;

export interface PromptOverride {
  file: string;
  mode: "append" | "replace";
  body: string;
}

/** Override files for a prompt: user packs, user, project packs, project (all apply, in that order). */
export function promptOverrides(root: string, name: PromptName): PromptOverride[] {
  const out: PromptOverride[] = [];
  const dirs = [
    ...packContentDirs(root, "prompts", "user").map((d) => d.dir),
    join(userConfigDir(), "prompts"),
    ...packContentDirs(root, "prompts", "project").map((d) => d.dir),
    join(root, ".yxu", "prompts"),
  ];
  for (const dir of dirs) {
    const file = join(dir, `${name}.md`);
    if (!existsSync(file)) continue;
    const { meta, body } = frontMatter(readFileSync(file, "utf8"));
    const mode = meta.mode === "replace" ? "replace" : "append";
    if (meta.mode !== undefined && meta.mode !== "replace" && meta.mode !== "append") {
      throw new Error(`${file}: mode must be "append" or "replace"`);
    }
    out.push({ file, mode, body: body.trim() });
  }
  return out;
}

/** The effective prompt: the built-in base with any overrides applied. */
export function prompt(root: string, name: PromptName, base: string, vars: Record<string, unknown> = {}): string {
  let text = base;
  for (const o of promptOverrides(root, name)) {
    const body = render(o.body, vars);
    text = o.mode === "replace" ? body : `${text.trimEnd()}\n\n${body}`;
  }
  return text;
}

/** Split `---` YAML front matter from a Markdown body. */
export function frontMatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = parseYaml(m[1]!) ?? {};
  if (typeof meta !== "object" || Array.isArray(meta)) throw new Error("front matter must be a YAML mapping");
  return { meta: meta as Record<string, unknown>, body: m[2]! };
}
