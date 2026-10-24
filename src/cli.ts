#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_YAML, getWorkflow, loadConfig, toProfile, type Config } from "./config.ts";
import { buildContextPrompt, compactSettings, formatTokens, settingSources } from "./context.ts";
import { applyTask, discardTask } from "./actions.ts";
import { combineTasks, readTaskRecord } from "./combine.ts";
import { repoRoot } from "./git.ts";
import { Session, TaskOps } from "./ops.ts";
import { runPipeline } from "./orchestrator/pipeline.ts";
import { orchestratorPrompt, runOrchestrator, sessionPath, type OrchestratorRender } from "./orchestrator/run.ts";
import { createYxuServer, SERVER_NAME, TOOL_NAMES } from "./orchestrator/tools.ts";
import { claudeExecutable, isCompiled, VERSION, which } from "./platform.ts";
import { killAllSubagents, newTaskId, runTask } from "./runner.ts";
import type { AgentProfile, CliName, TaskResult } from "./types.ts";

const USAGE = `yxu ${VERSION} — local multi-agent orchestrator

Usage:
  yxu                       open the interactive interface (same as yxu tui)
  yxu tui [-w workflow] [--ascii] [--reduced-motion] [--no-color] [--demo]
                            interactive interface; --demo replays a scripted run (no agents)
  yxu run "<goal>" [-w workflow] [--model M] [--budget USD]
                            Claude (Opus) plans and delegates to your local agents
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
  yxu init                  write a starter yxu.yaml in the repo root
  yxu agents                list configured agents and workflows
  yxu context               show what the orchestrator sees and how it compacts
  yxu models [agent|cli] [search] [--refresh] [--json]
                            list the models each agent CLI offers
  yxu doctor                check that agent CLIs are installed
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
    const cfg = loadConfig(repoRoot(process.cwd()));
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
    },
  });
  const root = repoRoot(process.cwd());
  const cfg = loadConfig(root);
  getWorkflow(cfg, values.workflow); // validate before taking over the screen
  const { runTui } = await import("./tui/index.ts");
  const { pending } = await runTui({
    cfg,
    root,
    workflow: values.workflow,
    demo: values.demo,
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
    },
  });
  const goal = positionals.join(" ").trim();
  if (!goal) die('missing goal, e.g. yxu run "add a --verbose flag"');

  const root = repoRoot(process.cwd());
  const cfg = loadConfig(root);
  if (values.model) cfg.orchestrator.model = values.model;
  if (values.budget) cfg.orchestrator.max_budget_usd = Number(values.budget);
  const workflow = getWorkflow(cfg, values.workflow);

  const ac = new AbortController();
  process.once("SIGINT", () => {
    console.error("\n✗ cancelling… (Ctrl-C again to force quit)");
    ac.abort();
    killAllSubagents();
    process.once("SIGINT", () => process.exit(130)); // exit handler SIGKILLs any subagent left
  });

  console.log(
    `${bold("yxu")} ${dim(`orchestrator ${cfg.orchestrator.model} · ${workflow.mode} workflow "${workflow.name}" · config ${cfg.source}`)}\n`,
  );

  const r = makeRenderer(cfg);
  const outcome =
    workflow.mode === "pipeline"
      ? await runPipeline({ goal, cfg, workflow, root, abort: ac, render: r.render })
      : await runOrchestrator({ goal, cfg, workflow, root, abort: ac, render: r.render });

  // The final report is usually the last assistant message, already printed above.
  if (outcome.finalText.trim() !== r.lastText()) console.log(`${bold("─── result ───")}\n${outcome.finalText}\n`);
  else console.log(bold("─── done ───"));
  const cost = `orchestrator $${outcome.costUsd.toFixed(4)} · subagents $${r.subagentCost().toFixed(4)}`;
  console.log(dim(`${outcome.session.tasks.size} task(s) · ${cost} · ${outcome.runId}`));
  printApplyHints(
    outcome.session.tips().map((t) => ({ taskId: t.taskId, agent: t.agent, includes: outcome.session.ancestorCount(t.taskId) })),
  );
  process.exit(outcome.ok ? 0 : 2);
}

function printApplyHints(tips: { taskId: string; agent: string; includes: number }[]) {
  if (!tips.length) return;
  console.log(`\nNothing has been applied. To review and apply:`);
  for (const t of tips) {
    console.log(`  yxu show ${t.taskId}    ${dim(`# ${t.agent}${t.includes ? `, includes ${t.includes} earlier task(s)` : ""}`)}`);
    console.log(`  yxu apply ${t.taskId}`);
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
    step: ({ id, type, index, total, note }) =>
      type === "fix"
        ? console.log(`  ↻ ${note} ${dim(`(round ${index}/${total})`)}`)
        : console.log(`\n${bold(`■ [${index}/${total}] ${id}`)} ${dim(type)}`),
    hooks: {
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
    options: { workflow: { type: "string", short: "w" }, session: { type: "string" } },
  });
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const root = repoRoot(process.cwd());
  const cfg = loadConfig(root);
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
    },
  });
  const root = repoRoot(process.cwd());
  const cfg = loadConfig(root);
  const workflow = getWorkflow(cfg, values.workflow);
  if (!which("claude")) die("`claude` not found on PATH");

  const runId = `chat-${newTaskId()}`;
  const sessionFile = sessionPath(root, runId);
  const [cmd, ...cmdArgs] = selfCommand();
  const mcpConfig = {
    mcpServers: {
      [SERVER_NAME]: { command: cmd, args: [...cmdArgs, "mcp", "-w", workflow.name, "--session", sessionFile], cwd: root },
    },
  };
  const args = [
    "claude",
    "--model", values.model ?? cfg.orchestrator.model,
    "--mcp-config", JSON.stringify(mcpConfig),
    "--append-system-prompt", orchestratorPrompt(workflow) +
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
  const proc = Bun.spawn(args, { cwd: root, stdio: [values.print ? "ignore" : "inherit", "inherit", "inherit"] });
  // Let claude handle Ctrl-C itself.
  process.on("SIGINT", () => {});
  const code = await proc.exited;

  if (existsSync(sessionFile)) {
    const snap = JSON.parse(readFileSync(sessionFile, "utf8"));
    printApplyHints(snap.tips ?? []);
  }
  process.exit(code ?? 0);
}

/** Guess the project's test command for `yxu init`. */
function detectVerify(root: string): string | undefined {
  const has = (f: string) => existsSync(join(root, f));
  if (has("package.json")) {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pkg.scripts?.test) return has("bun.lock") || has("bun.lockb") ? "bun run test" : has("pnpm-lock.yaml") ? "pnpm test" : "npm test";
  }
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py")) return "python -m pytest -q";
  if (has("Makefile") && /^test:/m.test(readFileSync(join(root, "Makefile"), "utf8"))) return "make test";
  return undefined;
}

function loadResult(root: string, id: string): TaskResult {
  return readTaskRecord(root, id) ?? die(`no task ${id}`);
}

function show(id: string) {
  const r = loadResult(repoRoot(process.cwd()), id);
  printResult(r);
  if (r.diff) console.log(`\n${r.diff}`);
}

function apply(id: string) {
  const r = applyTask(repoRoot(process.cwd()), id);
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

function init() {
  const root = repoRoot(process.cwd());
  const path = join(root, "yxu.yaml");
  if (existsSync(path)) die(`${path} already exists`);
  const verify = detectVerify(root);
  const yaml = verify
    ? DEFAULT_YAML.replace(/verify: npm test .*/, `verify: ${verify}   # detected; used by verify steps and the verify tool`)
    : DEFAULT_YAML.replace(/  verify: npm test .*\n/, "  # verify: npm test     # set your test command to enable verify steps\n").replace(
        /      - id: verify\n        type: verify\n        fix_agent: coder\n/,
        "",
      );
  writeFileSync(path, yaml);
  console.log(`✓ wrote ${path}${verify ? ` (verify: ${verify})` : ""}\n  edit the agents and models, then: yxu agents`);
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
  const { ModelCatalog } = await import("./models.ts");
  const catalog = new ModelCatalog();
  const all: CliName[] = ["commandcode", "opencode", "claude"];
  const [target, ...search] = positionals;
  let clis = all;
  if (target) {
    if ((all as string[]).includes(target)) clis = [target as CliName];
    else {
      const cfg = loadConfig(repoRoot(process.cwd()));
      const agent = cfg.agents[target] ?? die(`unknown agent or CLI "${target}"`);
      clis = [agent.cli];
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
    console.log(`\n${bold(cli)} ${dim(st.status === "error" ? `error: ${st.error}` : `${hits.length}${q ? ` of ${st.models.length}` : ""} models`)}`);
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

function doctor() {
  let bad = 0;
  console.log(`  yxu          ${VERSION}${isCompiled() ? " (binary)" : ""}  ${process.platform}-${process.arch}`);
  try {
    const engine = claudeExecutable();
    console.log(`✓ orchestrator ${engine ? `Claude Code at ${engine}` : "Claude Code engine bundled with the Agent SDK"}`);
  } catch (e) {
    bad++;
    console.log(`✗ orchestrator ${(e as Error).message}`);
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
    const p = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const ver = p.stdout.toString().trim().split("\n").at(-1) ?? "?";
    console.log(`✓ ${cli.padEnd(12)} ${ver}  (${path})`);
  }
  try {
    const cfg = loadConfig(repoRoot(process.cwd()));
    console.log(`✓ config       ${cfg.source} (${Object.keys(cfg.agents).length} agents)`);
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
      apply(rest[0] ?? die("missing task id"));
      break;
    case "discard":
      discard(rest[0] ?? die("missing task id"));
      break;
    case "init":
      init();
      break;
    case "agents":
      agents();
      break;
    case "doctor":
      doctor();
      break;
    case "context":
      contextInfo();
      break;
    case "models":
      await models(rest);
      break;
    default:
      console.log(USAGE);
      process.exit(cmd && !["help", "--help", "-h"].includes(cmd) ? 1 : 0);
  }
} catch (e) {
  die((e as Error).message);
}
