#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { getWorkflow, orchestratorLabel, loadConfig, toProfile, type Config } from "./config.ts";
import { loadLayers } from "./config-layers.ts";
import { buildContextPrompt, compactSettings, formatTokens, settingSources, worthCompacting } from "./context.ts";
import { applyWithHooks, discardTask } from "./actions.ts";
import { combineTasks, readTaskRecord } from "./combine.ts";
import { branchFor, repoRoot, tryGit } from "./git.ts";
import { Session, TaskOps } from "./ops.ts";
import { runPipeline } from "./orchestrator/pipeline.ts";
import { compactConversation, orchestratorPrompt, runOrchestrator, sessionPath, type OrchestratorRender, type RunOutcome } from "./orchestrator/run.ts";
import { Conversation, loadConversation, saveConversation } from "./conversation.ts";
import { issueGoal, resolveIssue, type Issue } from "./github.ts";
import { defaultBase, draftPr, openPr, recentTasks, tagIssue } from "./pr.ts";
import { fixCi } from "./fix-ci.ts";
import { spawn } from "node:child_process";
import { createYxuServer, SERVER_NAME, TOOL_NAMES } from "./orchestrator/tools.ts";
import { claudeExecutable, isCompiled, runAttached, runSync, VERSION, which } from "./platform.ts";
import { update } from "./update.ts";
import { withRunHooks } from "./hooks.ts";
import { needsTrust } from "./trust.ts";
import { pluginContext, setPluginHost } from "./plugins.ts";
import { sandboxAvailable } from "./sandbox.ts";
import { describe, type Answer, type Asker } from "./permissions.ts";
import { commandUsage, expandCommand, loadUserCommands } from "./user-commands.ts";
import { runVerify } from "./verify.ts";
import { killAllSubagents, newTaskId, runTask } from "./runner.ts";
import type { AgentProfile, CliName, TaskResult } from "./types.ts";

const USAGE = `yxu ${VERSION} — local multi-agent orchestrator

Usage:
  yxu                       open the interactive interface (same as yxu tui)
  yxu tui [-w workflow] [--ascii] [--reduced-motion] [--no-color] [--demo]
                            interactive interface; --demo replays a scripted run (no agents)
  yxu run "<goal>" [-w workflow] [--model M] [--budget USD] [-i name=value]... [--yes] [-c]
                            Claude (Opus) plans and delegates to your local agents;
                            pipelines take --input values, --yes approves their gates;
                            -c (--continue) continues the last conversation in this repo;
                            --issue 123|owner/repo#123|URL|linear:ENG-12 works on an issue
  yxu pr [task] [--title T] [--base B] [--branch name] [--draft] [--dry-run]
                            push a task's branch and open a pull request: what each agent
                            did, checks, review findings, "Closes #issue" (needs gh)
  yxu fix-ci <pr> [--agent name] [--rounds n] [--yes] [--no-push]
                            read a PR's failing CI logs, let the debugger fix them on the
                            PR's branch, verify, and push the fix
  yxu chat ["<first message>"] [-w workflow] [--model M] [--allow-edits] [--user-settings] [-p]
                            interactive Claude Code with the yxu tools
  yxu mcp [-w workflow]     stdio MCP server with the yxu tools (for any MCP client)
  yxu delegate <agent> "<task>"
                            run one task with an agent from yxu.yaml
  yxu delegate --cli <commandcode|opencode|claude> [-m model] [--permission yolo|accept-edits|plan]
               [--max-turns N] [--timeout SEC] [--no-worktree] [--json] "<task>"
                            run one task with an ad-hoc agent
  yxu combine <task-id> <task-id>... [--resolver agent]
                            merge several tasks into one new task (agent resolves conflicts)
  yxu show <task-id>        print the stored result and diff
  yxu apply <task-id>       merge the task branch into your current branch
  yxu discard <task-id>     delete the task worktree and branch
  yxu init [--yes] [--template team|minimal] [--pack name|none] [--agents a,b] [--force]
                            set up this repo: finds your agent CLIs, picks models and a
                            starter pack, writes a commented yxu.yaml with a team of
                            agents by role (or --template minimal: one per CLI)
  yxu add <source> [--user] [--as name] [--yes]
                            install a pack: a starter pack (python, node, rust, go),
                            github:owner/repo[/path][@ref], a git URL, or ./folder
  yxu plugins [list|approve [name...]|revoke <name>]
                            plugins (code) found here; this repo's load once you approve them
  yxu packs [list [-v]|update [name...]|remove <name>|install]
                            installed packs, pinned in yxu.lock (install: restore from the lock)
  yxu run "/<command> [args]"   run one of your commands (.yxu/commands/<command>.md)
  yxu commands              list your commands
  yxu trust [--revoke|--list]
                            let this repo's own config run commands (hooks, steps, agent commands)
  yxu keys                  the interface key bindings (rebind with ui.keys)
  yxu prompts [show <name>] built-in prompts and your overrides (.yxu/prompts/<name>.md)
  yxu config [explain|get|set|unset|paths|migrate|schema]
                            layered config: user → yxu.yaml → yxu.local.yaml → YXU_* → --set
  yxu agents                list configured agents and workflows
  yxu agent test <name> [--task T] [--keep]
                            run a tiny task in a scratch repo and show what yxu understood
  yxu agent capture <name> [--task T] [--out DIR]
                            the same, saving raw output (bug reports, adapter fixtures)
  yxu context               show what the orchestrator sees and how it compacts
  yxu models [agent|cli] [search] [--refresh] [--json]
                            list the models each agent CLI offers
  yxu doctor                check that agent CLIs are installed
  yxu update [--check] [--version vX.Y.Z]
                            update a release binary (npm/source installs: prints the command)
  yxu --version             print the yxu version
`;

const CLIS: CliName[] = ["commandcode", "opencode", "claude"];
const BINARIES: Record<CliName, string> = { commandcode: "cmd", opencode: "opencode", claude: "claude" };

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s);

function die(msg: string): never {
  console.error(`yxu: ${msg}`);
  process.exit(1);
}

const firstLine = (s: string, max = 90) => {
  const l = s.trim().split("\n")[0] ?? "";
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
};

function printResult(r: TaskResult) {
  const mark = r.ok ? "✓" : "✗";
  const secs = (r.durationMs / 1000).toFixed(1);
  const cost = r.costUsd !== undefined ? `  $${r.costUsd.toFixed(4)}` : "";
  const tok = `${r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens} in / ${r.usage.outputTokens} out`;
  console.log(`${mark} ${r.agent}${r.model ? ` (${r.model})` : ""}  ${secs}s  ${tok}${cost}`);
  console.log(`  task:   ${r.taskId}`);
  if (r.branch) console.log(`  branch: ${r.branch}`);
  if (r.error) console.log(`  error:  ${r.error}`);
  if (r.summary) console.log(`  summary: ${r.summary.split("\n").join("\n           ")}`);
  console.log(`  files:  ${r.filesChanged.length ? r.filesChanged.join(", ") : "(none)"}`);
  if (r.branch && r.filesChanged.length) {
    console.log(`\n  review: yxu show ${r.taskId}\n  apply:  yxu apply ${r.taskId}\n  drop:   yxu discard ${r.taskId}`);
  }
}

async function delegate(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cli: { type: "string" },
      model: { type: "string", short: "m" },
      permission: { type: "string" },
      "max-turns": { type: "string" },
      timeout: { type: "string" },
      agent: { type: "string" },
      "no-worktree": { type: "boolean" },
      json: { type: "boolean" },
      set: { type: "string", multiple: true },
    },
  });

  let agentName: string;
  let profile: AgentProfile;
  if (values.cli) {
    const cli = values.cli as CliName;
    if (!CLIS.includes(cli)) die(`--cli must be one of ${CLIS.join(", ")}`);
    const permission = values.permission as AgentProfile["permission"];
    if (permission && !["yolo", "accept-edits", "plan"].includes(permission)) die(`bad --permission ${permission}`);
    agentName = cli;
    profile = {
      cli,
      model: values.model,
      permission,
      agent: values.agent,
      maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
      timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
    };
  } else {
    const cfg = loadConfig(repoRoot(process.cwd()), { sets: values.set });
    agentName = positionals.shift() ?? die("missing agent name (or pass --cli)");
    const raw = cfg.agents[agentName] ?? die(`unknown agent "${agentName}" in ${cfg.source}`);
    profile = { ...toProfile(raw), ...(values.model ? { model: values.model } : {}) };
  }

  const prompt = positionals.join(" ").trim();
  if (!prompt) die("missing task text");

  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  if (!values.json) console.error(`▸ ${agentName} (${profile.cli}${profile.model ? ` / ${profile.model}` : ""}) running…`);

  const result = await runTask({
    agentName,
    profile,
    prompt,
    cwd: process.cwd(),
    isolate: !values["no-worktree"],
    signal: ac.signal,
  });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  process.exit(result.ok ? 0 : 2);
}

async function tui(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      workflow: { type: "string", short: "w" },
      ascii: { type: "boolean" },
      "reduced-motion": { type: "boolean" },
      "no-color": { type: "boolean" },
      demo: { type: "boolean" },
      set: { type: "string", multiple: true },
    },
  });
  const root = repoRoot(process.cwd());
  const cfg = loadConfig(root, { sets: values.set });
  getWorkflow(cfg, values.workflow); // validate before taking over the screen
  const { runTui } = await import("./tui/index.ts");
  const { pending } = await runTui({
    cfg,
    root,
    workflow: values.workflow,
    demo: values.demo,
    sets: values.set,
    ascii: values.ascii || undefined,
    reducedMotion: values["reduced-motion"] || undefined,
    depth: values["no-color"] ? "none" : undefined,
  });
  if (!values.demo) printApplyHints(pending.map((p) => ({ ...p, includes: 0 })));
  process.exit(0);
}

async function run(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      workflow: { type: "string", short: "w" },
      model: { type: "string", short: "m" },
      budget: { type: "string" },
      set: { type: "string", multiple: true },
      input: { type: "string", short: "i", multiple: true },
      yes: { type: "boolean", short: "y" },
      continue: { type: "boolean", short: "c" },
      issue: { type: "string" },
    },
  });
  let goal = positionals.join(" ").trim();
  const inputs: Record<string, string> = {};
  for (const kv of values.input ?? []) {
    const eq = kv.indexOf("=");
    if (eq < 1) die(`--input expects name=value, got "${kv}"`);
    inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
  }

  const root = repoRoot(process.cwd());
  const sets = [...(values.set ?? [])];
  if (values.model) sets.push(`orchestrator.model=${values.model}`);
  if (values.budget) sets.push(`orchestrator.max_budget_usd=${values.budget}`);
  const cfg = loadConfig(root, { sets });
  let workflow = getWorkflow(cfg, values.workflow);
  // `yxu run "/add-tests src/a.ts"` runs a custom command from .yxu/commands.
  if (goal.startsWith("/")) {
    const [name = "", ...args] = goal.slice(1).split(/\s+/);
    const pc = cfg.plugins?.commands.find((x) => `${x.plugin}:${x.command.name}` === name.toLowerCase());
    if (pc) {
      // A plugin's command: it may print notes and start runs of its own.
      setPluginHost({
        note: (m) => console.log(m),
        run: async (g, o = {}) => {
          const wf = getWorkflow(cfg, o.workflow ?? values.workflow);
          const outcome = await execute(g, wf, { ...inputs, ...o.inputs });
          return { ok: outcome.ok, result: outcome.finalText };
        },
      });
      await pc.command.run(pluginContext(pc.plugin, root, cfg as unknown as Record<string, unknown>), args);
      process.exit(0);
    }
    const { commands, errors } = loadUserCommands(root, cfg);
    const c = commands.find((x) => x.name === name.toLowerCase());
    if (!c) die(`no custom command /${name}${errors.length ? `\n${errors.join("\n")}` : ""} (see: yxu commands)`);
    const x = expandCommand(c, args, cfg);
    if (x.kind === "shell") {
      if (c.scope === "project" && cfg.trusted === false) die(`/${c.name} runs a command from this repository's .yxu/commands; trust the repo first: yxu trust`);
      console.log(`$ ${bold(firstLine(x.command, 100))}`);
      const v = await runVerify(root, x.command, cfg.settings.verify_timeout);
      if (v.output) console.log(v.output);
      process.exit(v.ok ? 0 : 2);
    }
    goal = x.goal;
    if (x.workflow) workflow = x.workflow;
    if (x.kind === "workflow") for (const [k, v] of Object.entries(x.inputs)) inputs[k] ??= v;
  }
  // --issue: the issue (text, comments, files it mentions) is the goal; anything typed is added to it.
  let issue: Issue | undefined;
  if (values.issue) {
    try {
      issue = await resolveIssue(root, cfg, values.issue);
    } catch (e) {
      die((e as Error).message);
    }
    console.log(dim(`issue ${issue.id}: ${issue.title}${issue.url ? ` (${issue.url})` : ""}`));
    goal = issueGoal(root, issue, goal);
  }
  if (!goal && workflow.mode !== "pipeline") die('missing goal, e.g. yxu run "add a --verbose flag" (or --issue 123)');
  if (Object.keys(inputs).length && workflow.mode !== "pipeline") die(`--input is for pipeline workflows; "${workflow.name}" is ${workflow.mode}`);
  const outcome = await execute(goal, workflow, inputs);
  process.exit(outcome.ok ? 0 : 2);

  async function execute(goal: string, workflow: ReturnType<typeof getWorkflow>, inputs: Record<string, string>) {
    const ac = new AbortController();
    process.once("SIGINT", () => {
      console.error("\n✗ cancelling… (Ctrl-C again to force quit)");
      ac.abort();
      killAllSubagents();
      process.once("SIGINT", () => process.exit(130)); // exit handler SIGKILLs any subagent left
    });

    console.log(
      `${bold("yxu")} ${dim(`orchestrator ${orchestratorLabel(cfg)} · ${workflow.mode} workflow "${workflow.name}" · config ${cfg.source}`)}\n`,
    );

    const r = makeRenderer(cfg);
    const session = new Session();
    // Auto runs are remembered in .yxu/conversation.json; --continue picks the last one up.
    const auto = workflow.mode === "auto";
    const conv = (values.continue && loadConversation(root)) || new Conversation();
    if (values.continue && !conv.sessionId) console.log(dim("(no earlier conversation in this repo: starting a new one)\n"));
    const next = auto && values.continue ? conv.next() : { usesSummary: false };
    if (next.usesSummary) console.log(dim("(continuing from a background summary of the conversation)\n"));
    const outcome = await withRunHooks(cfg, root, { goal, workflow: workflow.name, session, signal: ac.signal }, () =>
      workflow.mode === "pipeline"
        ? runPipeline({ goal, cfg, workflow, root, abort: ac, render: r.render, inputs, gate: cliGate(values.yes), session })
        : runOrchestrator({ goal, cfg, workflow, root, abort: ac, render: r.render, session, resume: next.resume, preamble: next.preamble }),
    );
    if (issue) tagIssue(root, outcome.session.tasks.keys(), issue);
    if (auto && !outcome.cancelled) await rememberConversation(root, cfg, conv, { goal, outcome, usedSummary: next.usesSummary, continuing: Boolean(values.continue) });

    // The final report is usually the last assistant message, already printed above.
    if (outcome.finalText.trim() !== r.lastText()) console.log(`${bold("─── result ───")}\n${outcome.finalText}\n`);
    else console.log(bold("─── done ───"));
    const cost = `orchestrator $${outcome.costUsd.toFixed(4)} · subagents $${r.subagentCost().toFixed(4)}`;
    console.log(dim(`${outcome.session.tasks.size} task(s) · ${cost} · ${outcome.runId}`));
    printApplyHints(
      outcome.session.tips().map((t) => ({ taskId: t.taskId, agent: t.agent, includes: outcome.session.ancestorCount(t.taskId) })),
    );
    return outcome;
  }
}

/**
 * After an auto run: save the conversation for `yxu run --continue`, keep a summary made during the
 * run, and if the window is filling, summarize it in a detached process (the shell is not held).
 */
async function rememberConversation(root: string, cfg: Config, conv: Conversation, t: { goal: string; outcome: RunOutcome; usedSummary: boolean; continuing: boolean }) {
  const disk = loadConversation(root);
  // A summary finished by a detached process during this run belongs to this conversation too.
  if (disk?.state.id === conv.state.id && disk.summary && !conv.summary && !t.usedSummary) conv.state.summary = disk.summary;
  conv.finish({ goal: t.goal, finalText: t.outcome.finalText, sessionId: t.outcome.sdkSessionId, usedSummary: t.usedSummary });
  const left = t.outcome.backgroundSummary;
  if (left && !conv.summary && t.continuing) {
    // Started near the end of the run: usually seconds from done. Ctrl-C skips it.
    console.log(dim("finishing the background summary for `yxu run -c`… (Ctrl-C skips)"));
    const done = await left.done;
    if (done?.sessionId) conv.adopt(conv.state.id, { sessionId: done.sessionId, afterTurn: conv.turn, tail: left.tail || undefined, preTokens: done.compaction?.preTokens, postTokens: done.compaction?.postTokens });
  }
  saveConversation(root, conv);
  const k = cfg.compact;
  const u = t.outcome.context;
  // Only for conversations being continued (-c): a summary of a one-off run would go unused.
  if (t.continuing && !conv.summary && conv.sessionId && k.auto && k.background && u && worthCompacting(u, k)) {
    const [cmd, ...args] = selfCommand();
    const child = spawn(cmd!, [...args, "__summarize", conv.state.id, conv.sessionId, String(conv.turn)], { cwd: root, detached: true, stdio: "ignore" });
    child.unref();
    console.log(dim(`context ${Math.round(u.percentage)}%: summarizing it in the background for the next \`yxu run -c\``));
  }
}

/** `yxu __summarize <conversation> <session> <turn>`: the detached half of rememberConversation. */
async function summarizeDetached([convId, sessionId, turn]: string[]) {
  const root = repoRoot(process.cwd());
  const cfg = loadConfig(root);
  const r = await compactConversation({ cfg, root, sessionId: sessionId!, abort: new AbortController(), fork: true });
  if (!r.ok || !r.sessionId) return;
  const conv = loadConversation(root);
  // Only if the conversation is still the one summarized and no other summary arrived first.
  if (!conv || conv.summary || !conv.adopt(convId!, { sessionId: r.sessionId, afterTurn: Number(turn), preTokens: r.compaction?.preTokens, postTokens: r.compaction?.postTokens })) return;
  saveConversation(root, conv);
}

/** Agent tool approvals on the command line: a terminal asks; without one, they are refused. */
function cliAsker(): Asker | undefined {
  if (!process.stdin.isTTY) return undefined;
  let queue = Promise.resolve();
  return (req) => {
    // One question at a time, even when parallel agents ask together.
    const answer = queue.then(async (): Promise<Answer> => {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const a = (await rl.question(`△ ${bold(describe(req))} — allow? [y]es once / [a]lways this run / [N]o `)).trim().toLowerCase();
        return a === "y" || a === "yes" ? "once" : a === "a" || a === "always" ? "always" : "deny";
      } finally {
        rl.close();
      }
    });
    queue = answer.then(() => undefined);
    return answer;
  };
}

/** Gates on the command line: --yes approves, a terminal asks, anything else can't answer. */
function cliGate(yes?: boolean): ((message: string, stepId: string) => Promise<boolean>) | undefined {
  if (yes) return async (message) => (console.log(`△ ${message} ${dim("(--yes)")}`), true);
  if (!process.stdin.isTTY) return undefined;
  return async (message) => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`△ ${bold(message)} [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

function printApplyHints(tips: { taskId: string; agent: string; includes: number }[]) {
  if (!tips.length) return;
  console.log(`\nNothing has been applied. To review and apply:`);
  for (const t of tips) {
    console.log(`  yxu show ${t.taskId}    ${dim(`# ${t.agent}${t.includes ? `, includes ${t.includes} earlier task(s)` : ""}`)}`);
    console.log(`  yxu apply ${t.taskId}`);
    console.log(`  yxu pr ${t.taskId}       ${dim("# or open a pull request with it")}`);
  }
}

/** `yxu pr [task]`: push a task's branch and open a pull request describing the work. */
async function prCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { title: { type: "string" }, base: { type: "string" }, branch: { type: "string" }, draft: { type: "boolean" }, "dry-run": { type: "boolean" } },
  });
  const root = repoRoot(process.cwd());
  const taskId = positionals[0] ?? recentTasks(root).find((id) => tryGit(root, "rev-parse", "--verify", "--quiet", branchFor(id)).ok);
  if (!taskId) die("no task with changes; run something first, or name a task: yxu pr <task>");
  try {
    if (values["dry-run"]) {
      const d = draftPr(root, taskId, { title: values.title });
      console.log(`${bold(d.title)}
${dim(`branch ${values.branch ?? d.branch} → ${values.base ?? defaultBase(root)}`)}

${d.body}`);
      return;
    }
    const url = openPr(root, taskId, { title: values.title, base: values.base, branch: values.branch, draft: values.draft }, (l) => console.log(dim(l)));
    console.log(`✓ ${url}`);
  } catch (e) {
    die((e as Error).message);
  }
}

/** `yxu fix-ci <pr>`: an agent fixes a pull request's failing CI, then the fix is pushed. */
async function fixCiCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { agent: { type: "string" }, rounds: { type: "string" }, yes: { type: "boolean", short: "y" }, "no-push": { type: "boolean" }, set: { type: "string", multiple: true } },
  });
  const pr = positionals[0] ?? die("usage: yxu fix-ci <pr number or url> [--agent name] [--rounds n] [--yes] [--no-push]");
  const root = repoRoot(process.cwd());
  const cfg = loadConfig(root, { sets: values.set });
  const ac = new AbortController();
  process.once("SIGINT", () => {
    console.error("\n✗ cancelling…");
    ac.abort();
    killAllSubagents();
  });
  const confirmPush = async (message: string) => {
    if (values["no-push"]) return false;
    if (values.yes) return true;
    if (!process.stdin.isTTY) return false;
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^(y|yes|)$/i.test((await rl.question(`△ ${message} [Y/n] `)).trim());
    } finally {
      rl.close();
    }
  };
  try {
    const r = await fixCi(root, cfg, pr, { agent: values.agent, rounds: values.rounds ? Number(values.rounds) : undefined, confirmPush, print: (l) => console.log(l), hooks: makeRenderer(cfg).render.hooks, signal: ac.signal });
    console.log(`${r.status === "failed" ? "✗" : "✓"} ${r.message}`);
    process.exit(r.status === "failed" ? 2 : 0);
  } catch (e) {
    die((e as Error).message);
  }
}

/** Console renderer shared by auto and pipeline runs. */
function makeRenderer(cfg: Config) {
  let subagentCost = 0;
  let lastText = "";
  const render: OrchestratorRender = {
    assistantText: (t) => {
      lastText = t.trim();
      console.log(`◆ ${lastText.split("\n").join("\n  ")}\n`);
    },
    toolCall: (name, input) => {
      const short = name.replace(/^mcp__yxu__/, "");
      if (["delegate", "combine", "discard", "verify", "StructuredOutput"].includes(short)) return; // printed by hooks
      if (short === "delegate_parallel") {
        const n = Array.isArray(input.tasks) ? input.tasks.length : "?";
        console.log(`⇉ ${bold(`${n} tasks in parallel`)} ${dim(`(max ${cfg.settings.concurrency} at once)`)}`);
        return;
      }
      const arg = input.file_path ?? input.pattern ?? input.task_id ?? input.path ?? "";
      console.log(dim(`  · ${short} ${String(arg)}`.trimEnd()));
    },
    compacted: (info) => {
      const tokens = `${Math.round(info.preTokens / 1000)}k${info.postTokens !== undefined ? ` → ${Math.round(info.postTokens / 1000)}k` : ""} tokens`;
      console.log(
        info.trigger === "background"
          ? `⁘ ${dim(`summarized in the background while subagents worked (${tokens}); the run continues from the summary`)}\n`
          : `⁘ ${dim(`conversation compacted (${info.trigger}, ${tokens})`)}\n`,
      );
    },
    step: ({ id, type, index, total, note }) =>
      type === "fix"
        ? console.log(`  ↻ ${note} ${dim(`(round ${index}/${total})`)}`)
        : note === "skipped"
          ? console.log(dim(`○ [${index}/${total}] ${id} skipped`))
          : console.log(`\n${bold(`■ [${index}/${total}] ${id}`)} ${dim(note ? `${type} · ${note}` : type)}`),
    ask: cliAsker(),
    hooks: {
      onAgentEvent: (_id, e) => {
        if (e.kind === "tool" && e.status !== "started") console.log(dim(`    ${e.status === "failed" ? "✗" : "·"} ${e.name}${e.target ? ` ${e.target}` : ""}`));
        else if (e.kind === "permission") console.log(`    △ ${e.tool} — ${e.decision}`);
      },
      onDelegateStart: ({ taskId, agent, model, task, buildOn }) =>
        console.log(`▸ ${bold(agent)} ${dim(`${model ?? ""} [${taskId}]${buildOn ? ` on ${buildOn}` : ""}`)}\n  ${firstLine(task)}`),
      onDelegateEnd: (r) => {
        subagentCost += r.costUsd ?? 0;
        const secs = `${(r.durationMs / 1000).toFixed(0)}s`;
        console.log(
          r.ok
            ? `  ✓ ${secs}  ${r.filesChanged.length ? r.filesChanged.join(", ") : "no changes"}\n`
            : `  ✗ ${secs}  ${firstLine(r.error ?? "failed", 120)}\n`,
        );
      },
      onCombineStart: (ids) => console.log(`⇶ ${bold("combine")} ${dim(ids.join(" + "))}`),
      onConflict: (files, id) => console.log(`  ! conflict merging ${id}: ${files.join(", ")}`),
      onCombineEnd: (r) => {
        subagentCost += r.costUsd ?? 0;
        console.log(r.ok ? `  ✓ ${dim(`[${r.taskId}]`)} ${firstLine(r.summary, 120)}\n` : `  ✗ ${firstLine(r.error ?? "failed", 120)}\n`);
      },
      onVerifyStart: (command, taskId) => console.log(`⚑ ${bold("verify")} ${dim(`${command}${taskId ? ` [${taskId}]` : ""}`)}`),
      onVerifyEnd: (v) =>
        console.log(
          v.ok
            ? `  ✓ passed ${dim(`${(v.durationMs / 1000).toFixed(1)}s`)}\n`
            : `  ✗ ${v.timedOut ? "timed out" : `failed (exit ${v.exitCode})`}  ${dim(firstLine(v.output.split("\n").at(-1) ?? "", 100))}\n`,
        ),
      onDiscard: (id) => console.log(dim(`  · discarded ${id}`)),
      onShellStart: ({ command }) => console.log(`$ ${bold(firstLine(command, 100))}`),
      onShellEnd: ({ result: v, task }) =>
        console.log(
          `  ${v.ok ? "✓" : "✗"} ${v.ok ? "ok" : v.timedOut ? "timed out" : `exit ${v.exitCode}`} ${dim(`${(v.durationMs / 1000).toFixed(1)}s`)}` +
            `${task ? `  changed ${task.filesChanged.join(", ")} ${dim(`[${task.taskId}]`)}` : ""}` +
            `${!v.ok && v.output ? `\n  ${dim(firstLine(v.output.split("\n").at(-1) ?? "", 100))}` : ""}`,
        ),
    },
  };
  return { render, subagentCost: () => subagentCost, lastText: () => lastText };
}

/** Command that re-invokes this CLI (works for `bun src/cli.ts` and a compiled binary). */
function selfCommand(): string[] {
  const script = process.argv[1];
  return script && /\.(ts|js|mjs)$/.test(script) ? [process.execPath, script] : [process.execPath];
}

/** stdio MCP server exposing the yxu tools (used by `yxu chat`, or any MCP client). */
async function mcp(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { workflow: { type: "string", short: "w" }, session: { type: "string" }, set: { type: "string", multiple: true } },
  });
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const root = repoRoot(process.cwd());
  const cfg = loadConfig(root, { sets: values.set });
  const workflow = getWorkflow(cfg, values.workflow);
  const session = new Session();
  const save = () => values.session && session.save(values.session, { mode: "chat", workflow: workflow.name });
  const ops = new TaskOps(cfg, root, session, { allowedAgents: workflow.allowed_agents, onChange: save });
  const server = createYxuServer(ops);
  await server.instance.connect(new StdioServerTransport());
  const shutdown = () => {
    killAllSubagents();
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.once("SIGTERM", shutdown);
}

/** Interactive Claude Code session with the yxu tools attached. */
async function chat(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      workflow: { type: "string", short: "w" },
      model: { type: "string", short: "m" },
      "allow-edits": { type: "boolean" },
      "user-settings": { type: "boolean" },
      print: { type: "boolean", short: "p" },
      set: { type: "string", multiple: true },
    },
  });
  const root = repoRoot(process.cwd());
  const cfg = loadConfig(root, { sets: values.set });
  const workflow = getWorkflow(cfg, values.workflow);
  if (!which("claude")) die("`claude` not found on PATH");

  const runId = `chat-${newTaskId()}`;
  const sessionFile = sessionPath(root, runId);
  const [cmd, ...cmdArgs] = selfCommand();
  const mcpConfig = {
    mcpServers: {
      [SERVER_NAME]: { command: cmd, args: [...cmdArgs, "mcp", "-w", workflow.name, "--session", sessionFile, ...(values.set ?? []).flatMap((x) => ["--set", x])], cwd: root },
    },
  };
  const args = [
    "claude",
    "--model", values.model ?? cfg.orchestrator.model,
    "--mcp-config", JSON.stringify(mcpConfig),
    "--append-system-prompt", orchestratorPrompt(workflow, root) +
      "\n\nThis is an interactive session: confirm the plan with the user before large delegations.\n\n" +
      buildContextPrompt(cfg, root).text,
    "--settings", JSON.stringify(compactSettings(cfg)),
    "--allowedTools", ...TOOL_NAMES,
  ];
  if (!values["allow-edits"]) args.push("--disallowedTools", "Edit", "Write", "NotebookEdit");
  if (!values["user-settings"] && !cfg.orchestrator.user_settings) {
    // Empty value = no settings files at all (context.project_instructions: false skips CLAUDE.md).
    args.push("--setting-sources", (settingSources(cfg) ?? []).join(","), "--strict-mcp-config");
  }
  if (values.print) {
    if (!positionals.length) die("chat -p needs a message");
    args.push("-p", "--permission-mode", "dontAsk");
  }
  if (positionals.length) args.push(positionals.join(" "));

  console.log(dim(`yxu chat · ${values.model ?? cfg.orchestrator.model} · workflow "${workflow.name}" · agents: ${Object.keys(cfg.agents).join(", ")}`));
  // Let claude handle Ctrl-C itself.
  process.on("SIGINT", () => {});
  const code = await runAttached(args, { cwd: root, stdin: values.print ? "ignore" : "inherit" });

  if (existsSync(sessionFile)) {
    const snap = JSON.parse(readFileSync(sessionFile, "utf8"));
    printApplyHints(snap.tips ?? []);
  }
  process.exit(code ?? 0);
}

function loadResult(root: string, id: string): TaskResult {
  return readTaskRecord(root, id) ?? die(`no task ${id}`);
}

function show(id: string) {
  const r = loadResult(repoRoot(process.cwd()), id);
  printResult(r);
  if (r.diff) console.log(`\n${r.diff}`);
}

async function apply(id: string) {
  const root = repoRoot(process.cwd());
  const r = await applyWithHooks(loadConfig(root), root, id);
  if (!r.ok) die(r.message + ("hint" in r && r.hint ? `\n  ${r.hint}` : ""));
  console.log(`✓ ${r.message}`);
}

async function combine(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { resolver: { type: "string" } },
  });
  if (positionals.length < 2) die("combine needs at least 2 task ids");
  const root = repoRoot(process.cwd());
  const cfg = loadConfig(root);
  const resolverName = values.resolver ?? cfg.settings.resolver;
  const resolver = resolverName
    ? { name: resolverName, profile: toProfile(cfg.agents[resolverName] ?? die(`unknown agent "${resolverName}"`)) }
    : undefined;
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  const r = await combineTasks({
    root,
    taskIds: positionals,
    resolver,
    signal: ac.signal,
    onConflict: (files, id) => console.error(`! conflict merging ${id}: ${files.join(", ")}`),
    onResolveStart: () => console.error(`▸ ${resolverName} resolving…`),
  });
  printResult(r);
  process.exit(r.ok ? 0 : 2);
}

function discard(id: string) {
  const r = discardTask(repoRoot(process.cwd()), id);
  if (!r.ok) die(r.message);
  console.log(`✓ ${r.message}`);
}

function agents() {
  const cfg = loadConfig(repoRoot(process.cwd()));
  console.log(dim(`config: ${cfg.source}`));
  console.log(`\norchestrator: claude / ${cfg.orchestrator.model}${cfg.orchestrator.effort ? ` (effort ${cfg.orchestrator.effort})` : ""}`);
  console.log(`\nagents:`);
  for (const [name, a] of Object.entries(cfg.agents)) {
    console.log(`  ${name.padEnd(14)} ${a.cli} / ${a.model ?? "(default model)"}${a.description ? dim(`  ${a.description}`) : ""}`);
  }
  const wfs = Object.entries(cfg.workflows);
  if (wfs.length) {
    console.log(`\nworkflows:`);
    for (const [name, wf] of wfs) {
      console.log(`  ${name.padEnd(14)} ${wf.mode}${wf.allowed_agents ? ` · agents: ${wf.allowed_agents.join(", ")}` : ""}`);
      if (wf.steps) console.log(dim(`  ${"".padEnd(14)} ${wf.steps.map((st) => `${st.id}(${st.type})`).join(" → ")}`));
    }
  }
}

/** List the models each agent CLI offers. */
async function models(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { refresh: { type: "boolean" }, json: { type: "boolean" } } });
  const { catalogKey, keyLabel, ModelCatalog } = await import("./models.ts");
  const catalog = new ModelCatalog();
  const all: string[] = ["commandcode", "opencode", "claude"];
  const [target, ...search] = positionals;
  let clis = all;
  if (target) {
    if (all.includes(target)) clis = [target];
    else {
      const cfg = loadConfig(repoRoot(process.cwd()));
      const agent = cfg.agents[target] ?? die(`unknown agent or CLI "${target}"`);
      clis = [catalogKey(agent)];
    }
  }
  const q = search.join(" ").toLowerCase();
  const result: Record<string, unknown> = {};
  for (const cli of clis) {
    if (values.refresh || catalog.get(cli).status !== "ready") await catalog.refresh(cli);
    const st = catalog.get(cli);
    const hits = st.models.filter((m) => !q || `${m.id} ${m.group} ${m.description}`.toLowerCase().includes(q));
    result[cli] = st.status === "error" ? { error: st.error } : hits;
    if (values.json) continue;
    console.log(`\n${bold(keyLabel(cli))} ${dim(st.status === "error" ? `error: ${st.error}` : `${hits.length}${q ? ` of ${st.models.length}` : ""} models`)}`);
    let group = "";
    for (const m of hits) {
      if (m.group !== group) console.log(dim(`  ${(group = m.group)}`));
      console.log(`    ${m.id}${m.isDefault ? " (default)" : ""}  ${dim(m.description)}`);
    }
  }
  if (values.json) console.log(JSON.stringify(result, null, 2));
}

/** Show what the orchestrator will see and how its conversations are compacted. */
function contextInfo() {
  const root = repoRoot(process.cwd());
  const cfg = loadConfig(root);
  const { context: c, compact: k } = cfg;
  const { files, text } = buildContextPrompt(cfg, root);
  console.log(dim(`config: ${cfg.source}`));
  console.log(`\n${bold("context")}`);
  console.log(`  memory               ${c.memory ? "on (tui conversations continue across messages)" : "off"}`);
  console.log(`  project instructions ${c.project_instructions ? "CLAUDE.md loaded" : "not loaded"}`);
  console.log(`  included files       ${files.length ? "" : "none"}`);
  for (const f of files) {
    console.log(`    ${f.missing ? "✗" : "✓"} ${f.path}  ${dim(f.missing ? (f.error ?? "not found") : `${formatTokens(f.chars)} chars${f.truncated ? `, truncated to ${formatTokens(c.include_max_chars)}` : ""}`)}`);
  }
  console.log(`  notes                ${c.notes?.trim() ? c.notes.trim().split("\n")[0] : "none"}`);
  console.log(`  diff budget          ${cfg.settings.max_diff_chars} chars per subagent result`);
  console.log(`  added to prompt      ~${formatTokens(Math.round(text.length / 4))} tokens`);
  console.log(`\n${bold("compact")}`);
  console.log(`  auto                 ${k.auto ? "on" : "off"}`);
  console.log(`  window               ${k.window === "auto" ? "model default" : `${formatTokens(k.window)} tokens`}`);
  console.log(`  instructions         ${k.instructions?.trim() || "default (task ids, decisions, changed files)"}`);
  console.log(`  warn at              ${Math.round(k.warn_at * 100)}% (tui)`);
  console.log(dim(`\nedit yxu.yaml, or change live in the tui with /context and /compact (then /context save)`));
  if (files.some((f) => f.missing)) process.exit(1);
}

async function doctor() {
  let bad = 0;
  console.log(`  yxu          ${VERSION}${isCompiled() ? " (binary)" : ""}  ${process.platform}-${process.arch}`);
  let provider = "claude";
  try {
    const c = loadConfig(repoRoot(process.cwd()));
    provider = c.orchestrator.provider ?? "claude";
    if (provider === "agent") console.log(`✓ orchestrator agent ${c.orchestrator.agent} answers pipeline plan and review steps (auto workflows need claude)`);
    else if (provider !== "claude") console.log(`✓ orchestrator ${provider} (plugin ${c.plugins?.orchestrators.get(provider)?.plugin}) answers pipeline plan and review steps (auto workflows need claude)`);
  } catch {
    // the config check below reports it
  }
  try {
    const engine = claudeExecutable();
    console.log(`${provider === "claude" ? "✓ orchestrator" : "✓ claude     "} ${engine ? `Claude Code at ${engine}` : "Claude Code engine bundled with the Agent SDK"}`);
  } catch (e) {
    if (provider === "claude") bad++;
    console.log(`${provider === "claude" ? "✗" : "!"} orchestrator ${(e as Error).message}`);
  }
  for (const cli of CLIS) {
    const bin = BINARIES[cli];
    const path = which(bin);
    if (!path) {
      bad++;
      console.log(`✗ ${cli.padEnd(12)} \`${bin}\` not found on PATH`);
      continue;
    }
    // `cmd` self-updates on any invocation unless told not to.
    const args = cli === "commandcode" ? ["--version", "--no-auto-update"] : ["--version"];
    const ver = runSync([bin, ...args]).stdout.trim().split("\n").at(-1) ?? "?";
    console.log(`✓ ${cli.padEnd(12)} ${ver}  (${path})`);
  }
  try {
    const { config: cfg, layers } = loadLayers(repoRoot(process.cwd()));
    console.log(`✓ config       ${cfg.source} (${Object.keys(cfg.agents).length} agents)`);
    const pending = needsTrust(cfg);
    if (pending.length) console.log(`! trust        this repo is not trusted, so its config can't run: ${pending.join("; ")} — \`yxu trust\` if you trust it`);
    else console.log(`✓ trust        ${cfg.trusted === false ? "not trusted (its config runs no commands)" : "trusted"}`);
    for (const [name, a] of Object.entries(cfg.agents)) {
      if (a.permission === "yolo") console.log(`! permission   ${name} runs with yolo: it may run any command without asking (in its own worktree${a.sandbox === "bwrap" ? ", sandboxed" : ""})`);
      if (a.sandbox === "bwrap") {
        const why = sandboxAvailable();
        if (why) {
          bad++;
          console.log(`✗ sandbox      ${name}: ${why}`);
        }
      }
      if ((a.cli === "acp" || a.cli === "generic") && a.command && !which(a.command[0]!)) {
        bad++;
        console.log(`✗ agent        ${name}: \`${a.command[0]}\` not found on PATH`);
      }
    }
    for (const e of cfg.plugins?.entries ?? []) {
      const what = `${e.plugin?.name ?? e.id} (${e.scope}${e.pack ? `, pack ${e.pack}` : ""})`;
      if (e.status === "loaded") console.log(`✓ plugin       ${what}`);
      else if (e.status === "error") {
        bad++;
        console.log(`✗ plugin       ${what}: ${e.error}`);
      } else console.log(`! plugin       ${what} ${e.status === "changed" ? "changed since you approved it" : "waits for approval"}: \`yxu plugins approve\``);
    }
    const { packStatus } = await import("./pack-install.ts");
    for (const p of packStatus(repoRoot(process.cwd()))) {
      const what = `${p.name}${p.version ? ` ${p.version}` : ""} (${p.scope}${p.source ? `, ${p.source}` : ""})`;
      if (p.state === "ok") console.log(`✓ pack         ${what}`);
      else if (p.state === "missing") {
        bad++;
        console.log(`✗ pack         ${what} is in yxu.lock but not installed: \`yxu packs install\``);
      } else console.log(`! pack         ${what} ${p.state === "modified" ? "differs from yxu.lock (edited by hand?); `yxu packs update` re-pins it" : "is not in yxu.lock; reinstall it with `yxu add`"}`);
    }
    for (const l of layers) {
      if (l.file && l.exists && !l.pack && l.version === undefined) console.log(`! config       ${l.file} has no version; run \`yxu config migrate\``);
    }
  } catch (e) {
    bad++;
    console.log(`✗ config       ${(e as Error).message}`);
  }
  process.exit(bad ? 1 : 0);
}

const argv = process.argv.slice(2);
// `yxu --demo`, `yxu -w feature`: interface flags without a subcommand open the interface.
if (argv[0]?.startsWith("-") && !["-h", "--help", "-v", "--version"].includes(argv[0])) argv.unshift("tui");
const [cmd, ...rest] = argv;
try {
  switch (cmd ?? (process.stdin.isTTY && process.stdout.isTTY ? "tui" : undefined)) {
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      break;
    case "tui":
      await tui(rest);
      break;
    case "run":
      await run(rest);
      break;
    case "pr":
      await prCommand(rest);
      break;
    case "fix-ci":
      await fixCiCommand(rest);
      break;
    case "__summarize":
      await summarizeDetached(rest);
      break;
    case "delegate":
      await delegate(rest);
      break;
    case "chat":
      await chat(rest);
      break;
    case "mcp":
      await mcp(rest);
      break;
    case "combine":
      await combine(rest);
      break;
    case "show":
      show(rest[0] ?? die("missing task id"));
      break;
    case "apply":
      await apply(rest[0] ?? die("missing task id"));
      break;
    case "discard":
      discard(rest[0] ?? die("missing task id"));
      break;
    case "init": {
      const { values } = parseArgs({ args: rest, options: { yes: { type: "boolean", short: "y" }, template: { type: "string", short: "t" }, pack: { type: "string" }, agents: { type: "string" }, force: { type: "boolean" } } });
      const { init } = await import("./init.ts");
      await init({ yes: values.yes, template: values.template, pack: values.pack, agents: values.agents?.split(",").map((a) => a.trim()).filter(Boolean), force: values.force }, (l) => console.log(l), dim);
      break;
    }
    case "add": {
      const { addCommand } = await import("./packs-cli.ts");
      process.exit(await addCommand(rest));
    }
    case "plugins": {
      const { pluginsCommand } = await import("./plugins-cli.ts");
      process.exit(pluginsCommand(rest));
    }
    case "packs": {
      const { packsCommand } = await import("./packs-cli.ts");
      process.exit(await packsCommand(rest));
    }
    case "agents":
      agents();
      break;
    case "doctor":
      await doctor();
      break;
    case "context":
      contextInfo();
      break;
    case "models":
      await models(rest);
      break;
    case "agent": {
      const [sub, name, ...more] = rest;
      if ((sub !== "test" && sub !== "capture") || !name) die("usage: yxu agent test <name> [--task T] [--keep] | yxu agent capture <name> [--task T] [--out DIR]");
      const { values } = parseArgs({ args: more, options: { task: { type: "string" }, keep: { type: "boolean" }, out: { type: "string" }, set: { type: "string", multiple: true } } });
      const { agentTest } = await import("./agent-test.ts");
      const root = repoRoot(process.cwd());
      const cfg = loadConfig(root, { sets: values.set });
      const out = sub === "capture" ? (values.out ?? join(root, `yxu-capture-${name}-${newTaskId()}`)) : undefined;
      const pass = await agentTest(cfg, name, { task: values.task, keep: values.keep, captureDir: out, ask: cliAsker(), print: (l) => console.log(l), dim });
      process.exit(pass ? 0 : 1);
    }
    case "trust": {
      const { isTrusted, needsTrust, setTrust, trustedRepos } = await import("./trust.ts");
      const { values } = parseArgs({ args: rest, options: { revoke: { type: "boolean" }, list: { type: "boolean" } } });
      if (values.list) {
        const repos = trustedRepos();
        console.log(repos.length ? repos.join("\n") : "no trusted repositories");
        break;
      }
      const root = repoRoot(process.cwd());
      if (values.revoke) {
        setTrust(root, false);
        console.log(`✓ ${root} is no longer trusted`);
        break;
      }
      const before = isTrusted(root);
      setTrust(root, true);
      const items = needsTrust({ ...loadConfig(root), trusted: false });
      console.log(`✓ ${before ? "already trusted" : "trusted"}: ${root}`);
      if (items.length) console.log(dim(`  its config may now run:\n${items.map((i) => `  - ${i}`).join("\n")}`));
      break;
    }
    case "commands": {
      const root = repoRoot(process.cwd());
      const ccfg = loadConfig(root);
      const { commands, errors } = loadUserCommands(root, ccfg);
      const fromPlugins = ccfg.plugins?.commands ?? [];
      if (!commands.length && !errors.length && !fromPlugins.length) console.log("no custom commands; add Markdown files to .yxu/commands/ or ~/.config/yxu/commands/");
      for (const c of commands) console.log(`/${c.name}${c.args.length ? ` ${commandUsage(c)}` : ""}  ${dim(`${c.description} · ${c.kind} · ${c.scope}`)}`);
      for (const { plugin, command } of fromPlugins) console.log(`/${plugin}:${command.name}${command.usage ? ` ${command.usage}` : ""}  ${dim(`${command.description ?? ""} · plugin`)}`);
      for (const e of errors) console.log(`✗ ${e}`);
      process.exit(errors.length ? 1 : 0);
    }
    case "keys": {
      const { buildKeymap, KEY_ACTIONS } = await import("./keymap.ts");
      const km = buildKeymap(loadConfig(repoRoot(process.cwd())).ui.keys);
      for (const [a, spec] of Object.entries(km.bindings)) {
        const def = KEY_ACTIONS[a as keyof typeof KEY_ACTIONS];
        console.log(`${spec.padEnd(14)} ${a.padEnd(12)} ${dim(def.about)}${spec !== def.key ? `  (default ${def.key})` : ""}`);
      }
      for (const w of km.warnings) console.log(`! ${w}`);
      console.log(dim("\nrebind with ui.keys, e.g.  yxu config set ui.keys.panel ctrl+b --user"));
      break;
    }
    case "prompts": {
      const { promptsCommand } = await import("./prompts-cli.ts");
      process.exit(promptsCommand(rest));
    }
    case "config": {
      const { configCommand } = await import("./config-cli.ts");
      process.exit(await configCommand(rest));
    }
    case "update": {
      const { values } = parseArgs({ args: rest, options: { check: { type: "boolean" }, version: { type: "string" } } });
      process.exit(await update({ check: values.check, version: values.version }));
    }
    default:
      console.log(USAGE);
      process.exit(cmd && !["help", "--help", "-h"].includes(cmd) ? 1 : 0);
  }
} catch (e) {
  die((e as Error).message);
}
