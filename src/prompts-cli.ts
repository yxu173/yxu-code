/** `yxu prompts`: the built-in prompts and the overrides that apply to them. */
import { repoRoot } from "./git.ts";
import { display } from "./config-layers.ts";
import { ORCHESTRATOR_BASE, plannerBase, prompt, PROMPT_NAMES, PROMPTS, promptOverrides, resolverBase, reviewerBase, SUBAGENT_PREAMBLE, type PromptName } from "./prompts.ts";

/** The base text, with example values where a prompt depends on the run. */
function sampleBase(name: PromptName): { base: string; vars: Record<string, unknown> } {
  switch (name) {
    case "orchestrator":
      return { base: ORCHESTRATOR_BASE, vars: { workflow: { name: "default" } } };
    case "planner":
      return { base: plannerBase(5), vars: { max_tasks: 5, goal: "<goal>" } };
    case "reviewer":
      return { base: reviewerBase("<task>"), vars: { head: "<task>", goal: "<goal>" } };
    case "subagent-preamble":
      return { base: SUBAGENT_PREAMBLE, vars: {} };
    case "conflict-resolver":
      return { base: resolverBase("- <task>: <intent>", "<files>"), vars: { intents: "- <task>: <intent>", conflicts: "<files>" } };
  }
}

export function promptsCommand(argv: string[]): number {
  const root = repoRoot(process.cwd());
  const [sub, name] = argv;
  if (!sub || sub === "list") {
    for (const n of PROMPT_NAMES) {
      const o = promptOverrides(root, n);
      const how = o.length ? o.map((x) => `${x.mode} ${display(x.file, root)}`).join(", ") : "built-in";
      console.log(`${n.padEnd(18)} ${how}\n${"".padEnd(18)} ${PROMPTS[n].about}${PROMPTS[n].vars.length ? `; variables: ${PROMPTS[n].vars.map((v) => `{{${v}}}`).join(" ")}` : ""}`);
    }
    console.log("\noverride one with .yxu/prompts/<name>.md (team) or ~/.config/yxu/prompts/<name>.md (you);\nfront matter `mode: replace` replaces it, otherwise the file is appended");
    return 0;
  }
  if (sub === "show" && name && (PROMPT_NAMES as readonly string[]).includes(name)) {
    const { base, vars } = sampleBase(name as PromptName);
    process.stdout.write(`${prompt(root, name as PromptName, base, vars).trimEnd()}\n`);
    return 0;
  }
  console.error(`usage: yxu prompts [list | show <${PROMPT_NAMES.join("|")}>]`);
  return 1;
}
