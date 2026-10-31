/**
 * Slash commands: one registry drives execution, the `/` palette, argument completion, and help.
 * Every command is a thin layer over App methods; nothing here talks to agents directly.
 */
import { spawnSync } from "node:child_process";
import { agentRefs, parseDuration, spawnPool } from "../config.ts";
import { tryGit } from "../git.ts";
import { which } from "../platform.ts";
import { liveTasks } from "../runner.ts";
import { ACCESS, ACCESS_MODES } from "../access.ts";
import { fieldNamed, ORCHESTRATOR_FIELDS } from "../orchestrator-settings.ts";
import { ago, listSessions } from "../sessions.ts";
import type { CliName } from "../types.ts";
import { commandUsage, type UserCommand } from "../user-commands.ts";
import { catalogKey, keyLabel } from "../models.ts";
import { BUILTIN_THEMES, themeFiles } from "./themes.ts";
import type { App } from "./app.ts";

export interface Suggestion {
  /** Text that replaces the token being completed. */
  value: string;
  /** Shown in the left column (defaults to value). */
  label?: string;
  description?: string;
}

export interface Command {
  name: string;
  aliases?: string[];
  /** Argument synopsis, e.g. "<task>" or "[name]". */
  usage?: string;
  description: string;
  group: "session" | "orchestrator" | "agents" | "context" | "tasks" | "interface" | "custom";
  /** True when the command needs at least one argument (the palette then waits for it). */
  needsArgs?: boolean;
  /** Also match argument suggestions by description (e.g. "free", "1m ctx" for models). */
  searchDescriptions?: boolean;
  /** Suggestions for argument `index`, given the arguments typed before it. */
  complete?(app: App, index: number, before: string[]): Suggestion[];
  run(app: App, args: string[]): void | Promise<void>;
}

export function onOff(v: string | undefined): boolean | undefined {
  const t = v?.toLowerCase();
  return t === "on" || t === "true" || t === "yes" ? true : t === "off" || t === "false" || t === "no" ? false : undefined;
}

const ON_OFF: Suggestion[] = [
  { value: "on", description: "enable" },
  { value: "off", description: "disable" },
];

/** Models a CLI reports (from the catalog), current one first. */
function modelSuggestions(app: App, cli: string, current?: string): Suggestion[] {
  const st = app.catalog.get(cli);
  const items: Suggestion[] = st.models.map((m) => ({
    value: m.id,
    description: [m.group, m.description, m.isDefault ? "(cli default)" : ""].filter(Boolean).join(" · "),
  }));
  if (current) {
    const i = items.findIndex((x) => x.value === current);
    const cur = i >= 0 ? items.splice(i, 1)[0]! : { value: current, description: "" };
    items.unshift({ ...cur, description: `current${cur.description ? ` · ${cur.description}` : ""}` });
  }
  return items;
}

/** One-line status of a CLI's model list, for the palette. */
export function catalogStatus(app: App, key: string): string | undefined {
  const st = app.catalog.get(key);
  const cli = keyLabel(key);
  if (st.status === "loading") return `loading models from ${cli}…`;
  if (st.status === "error") return `could not list ${cli} models: ${st.error} — /models refresh to retry`;
  return st.models.length ? `${st.models.length} ${cli} models · type to search ids and descriptions` : undefined;
}

const EFFORTS: Suggestion[] = ["low", "medium", "high", "xhigh", "max"].map((v) => ({ value: v, description: `${v} reasoning effort` }));

function taskSuggestions(app: App, pendingOnly: boolean): Suggestion[] {
  return app.store.state.tasks
    .filter((t) => !pendingOnly || t.pending)
    .slice()
    .reverse()
    .map((t) => ({ value: t.taskId, label: t.taskId.slice(t.taskId.lastIndexOf("-") + 1), description: `${t.agent} · ${t.pending ? "pending" : t.state} · ${t.title}` }));
}

const AGENT_USAGE = "<name> <field> <value> | new <name> <cli> [model] | remove <name>";
const AGENT_FIELDS: Suggestion[] = [
  { value: "model", description: "model the agent's CLI uses" },
  { value: "cli", description: "switch provider: commandcode | opencode | claude … [model]" },
  { value: "role", description: "when the orchestrator should use it (its description)" },
  { value: "instructions", description: "role prompt put before every task it gets" },
  { value: "permission", description: "yolo | accept-edits | plan (read-only)" },
  { value: "timeout", description: "e.g. 15m, 90s" },
  { value: "turns", description: "max turns per task" },
];

/** CLIs an agent can be switched to or created with here (acp/generic need a command: yxu.yaml). */
function switchableClis(app: App): string[] {
  return ["commandcode", "opencode", "claude", ...(app.cfg.plugins ? [...app.cfg.plugins.agents.keys()] : [])];
}

function cliSuggestions(app: App): Suggestion[] {
  const about: Record<string, string> = { commandcode: "Command Code (cmd)", opencode: "OpenCode", claude: "Claude Code" };
  return switchableClis(app).map((c) => ({ value: c, description: about[c] ?? `from plugin ${app.cfg.plugins?.agents.get(c)?.plugin ?? ""}` }));
}

function warnUnknownModel(app: App, name: string, key: string, model: string) {
  const known = app.catalog.get(key);
  // Short names (e.g. "kimi-k2.5") are valid for some CLIs, so this only warns.
  if (known.status === "ready" && known.models.length && !known.models.some((m) => m.id === model || m.id.endsWith(`/${model}`))) {
    app.note(`${model} is not in the ${known.models.length} models ${keyLabel(key)} reported. If the agent fails, pick one with /agent ${name} model.`, "attention");
  }
}

function newAgent(app: App, name: string | undefined, [cli, model]: string[]) {
  if (!name || !cli) return app.fail("usage: /agent new <name> <cli> [model]", `clis: ${switchableClis(app).join(", ")}`);
  if (!/^[a-z][a-z0-9-]*$/.test(name) || name === "new" || name === "remove") return app.fail(`"${name}" can't be an agent name`, "use a lowercase word, e.g. security-reviewer");
  if (app.cfg.agents[name]) return app.fail(`agent "${name}" already exists`, `change it with /agent ${name} <field> <value>`);
  if (!switchableClis(app).includes(cli)) return app.fail(`unknown cli "${cli}"`, `clis: ${switchableClis(app).join(", ")}; acp and generic agents need a command (edit yxu.yaml, see docs/AGENTS.md)`);
  app.setConfig(["agents", name], { cli, ...(model ? { model } : {}) });
  app.changed(`Added ${name} (${cli}${model ? ` · ${model}` : ""})`);
  app.note(`Tell the orchestrator when to use it: \`/agent ${name} role <when>\`. Give it a role prompt: \`/agent ${name} instructions <text>\`. Make it read-only: \`/agent ${name} permission plan\`.`, "info");
  void app.catalog.refresh(cli).catch(() => {});
}

function removeAgent(app: App, name: string | undefined) {
  if (!name || !app.cfg.agents[name]) return app.fail(name ? `unknown agent "${name}"` : "usage: /agent remove <name>", "type /agents to list them");
  const refs = agentRefs(app.cfg, name);
  if (refs.length) return app.fail(`${name} is still used by ${refs.join("; ")}`, "point those at another agent first (e.g. /resolver <agent>), or edit yxu.yaml");
  if (Object.keys(app.cfg.agents).length === 1) return app.fail("can't remove the last agent");
  // null removes it from lower layers too (the built-in team, packs, your user config).
  app.setConfig(["agents", name], undefined, null);
  app.changed(`Removed ${name}`);
}

/** This repository's saved sessions, newest first. */
function sessionSuggestions(app: App): Suggestion[] {
  return listSessions({ root: app.root })
    .slice(0, 30)
    .map((s) => ({ value: s.id, description: `${s.title} · ${s.conversation.turn} turns · ${ago(s.updatedAt)}` }));
}

/** Agents running right now, for /watch, /tell, /pause … */
function liveSuggestions(): Suggestion[] {
  return liveTasks().map((t) => ({ value: t.taskId.slice(t.taskId.lastIndexOf("-") + 1), description: `${t.agent} · ${t.state}` }));
}

function agentSuggestions(app: App): Suggestion[] {
  return Object.entries(app.cfg.agents).map(([name, a]) => ({ value: name, description: `${a.cli}${a.model ? ` · ${a.model}` : ""}` }));
}

/** Repo files for `/context add`, from git (tracked + untracked, not ignored). */
function fileSuggestions(app: App, prefix: string): Suggestion[] {
  const r = tryGit(app.root, "ls-files", "--cached", "--others", "--exclude-standard");
  if (!r.ok) return [];
  const p = prefix.toLowerCase();
  return r.out
    .split("\n")
    .filter((f) => f && f.toLowerCase().includes(p) && !app.cfg.context.include.includes(f))
    .sort((a, b) => Number(!a.toLowerCase().startsWith(p)) - Number(!b.toLowerCase().startsWith(p)) || a.length - b.length)
    .slice(0, 40)
    .map((f) => ({ value: f }));
}

const SAVE_TARGETS = [
  { value: "project", description: "yxu.yaml — shared with your team" },
  { value: "local", description: "yxu.local.yaml — just you, this repo (git-ignored)" },
  { value: "user", description: "~/.config/yxu/config.yaml — just you, every repo" },
];

/** Section names plus every leaf key that is set, for /config completion. */
function configKeys(app: App) {
  const keys = new Set<string>(["orchestrator", "agents", "workflows", "settings", "context", "compact"]);
  // Every prefix too (agents.coder, not just agents.coder.cli), so enter on a typed section keeps it.
  for (const k of Object.keys(app.cfg.origins ?? {})) {
    const parts = k.split(".");
    for (let i = 2; i <= parts.length; i++) keys.add(parts.slice(0, i).join("."));
  }
  return [...keys].map((value) => ({ value, description: app.cfg.origins?.[value] ? `from ${app.cfg.origins[value]}` : "" }));
}

export const COMMANDS: Command[] = [
  // ── session ──
  { name: "help", description: "Keys, commands, and what every sign means", group: "session", run: (app) => app.store.set({ helpOpen: true }) },
  { name: "status", description: "Session settings, memory, context use, and cost", group: "session", run: (app) => app.showStatus() },
  { name: "new", description: "Start a new, empty chat (this one is saved: /resume brings it back)", group: "session", run: (app) => app.newConversation() },
  { name: "clear", description: "Clear the conversation view (tasks are kept)", group: "session", run: (app) => app.clearView() },
  {
    name: "save",
    usage: "[project|local|user]",
    description: "Save this session's setting changes (yxu.yaml, yxu.local.yaml or your user config)",
    group: "session",
    complete: (_app, i) => (i === 0 ? SAVE_TARGETS : []),
    run: (app, args) => app.saveConfig(args[0]),
  },
  {
    name: "config",
    usage: "[key]",
    description: "Show every setting and which config layer set it",
    group: "session",
    complete: (app, i) => (i === 0 ? configKeys(app) : []),
    run: (app, args) => app.explainConfig(args[0]),
  },
  { name: "doctor", description: "Check that the agent CLIs are installed", group: "session", run: (app) => doctor(app) },
  { name: "quit", aliases: ["exit"], description: "Exit yxu (pending results are listed on exit)", group: "session", run: (app) => app.quit() },

  // ── orchestrator ──
  {
    name: "trust",
    usage: "[off]",
    description: "Trust this repository so commands from its own config may run",
    group: "session",
    complete: (_app, i) => (i === 0 ? [{ value: "off", description: "stop trusting this repository" }] : []),
    run: (app, [v]) => app.trustRepo(v === "off"),
  },
  {
    name: "commands",
    description: "List your own commands (.yxu/commands) and reload them from disk",
    group: "session",
    run: (app) => app.reloadUserCommands(true),
  },
  {
    name: "plugins",
    usage: "[approve [name]|revoke <name>]",
    description: "Plugins: what they add, and approving the ones from this repo",
    group: "session",
    complete: (app, i) =>
      i === 0
        ? [
            { value: "approve", description: "load this repo's plugins that wait for approval" },
            { value: "revoke", description: "stop loading a plugin from this repo" },
          ]
        : (app.cfg.plugins?.entries ?? []).filter((e) => e.scope === "project").map((e) => ({ value: e.plugin?.name ?? e.id, description: e.status })),
    run: (app, [sub, name]) => (sub === "approve" ? app.approvePlugins(name) : sub === "revoke" ? app.revokePlugin(name) : app.listPlugins()),
  },
  {
    name: "packs",
    description: "Installed packs and what they add (install with `yxu add` in a shell)",
    group: "session",
    run: (app) => app.listPacks(),
  },
  {
    name: "run",
    usage: "<workflow> [name=value]… [goal]",
    description: "Run a workflow once, with inputs (e.g. /run release version=1.2.0)",
    group: "orchestrator",
    complete: (app, i, before) => {
      if (i === 0) return Object.entries(app.cfg.workflows).map(([n, w]) => ({ value: n, description: w.description ?? w.mode }));
      const wf = app.cfg.workflows[before[0] ?? ""];
      const given = new Set(before.slice(1).map((b) => b.split("=")[0]));
      return Object.entries(wf?.inputs ?? {})
        .filter(([k]) => !given.has(k))
        .map(([k, d]) => ({ value: `${k}=`, description: `${d.description ?? "input"}${d.default !== undefined ? ` (default ${d.default})` : ""}` }));
    },
    run: (app, args) => app.runWorkflow(args),
  },
  {
    name: "workflow",
    usage: "[name]",
    description: "Show or switch the workflow",
    group: "orchestrator",
    complete: (app, i) =>
      i === 0 ? Object.entries(app.cfg.workflows).map(([n, w]) => ({ value: n, description: `${w.mode}${w.steps ? ` · ${w.steps.map((s) => s.id).join(" → ")}` : ""}` })) : [],
    run: (app, args) => app.switchWorkflow(args.join(" ").trim()),
  },
  {
    name: "permissions",
    usage: "[ask|auto|full]",
    description: "How much runs without asking: ask for approval, approve for me, or full access (shift+tab cycles)",
    group: "session",
    complete: (_app, i) => (i === 0 ? ACCESS_MODES.map((m) => ({ value: m, description: `${ACCESS[m].label} — ${ACCESS[m].about}` })) : []),
    run: (app, [m]) => app.setAccess(m ?? ""),
  },
  {
    name: "image",
    usage: "[path|clear]",
    description: "Attach an image to your next message (no path: the clipboard's; ctrl+v does the same)",
    group: "session",
    complete: (_app, i) => (i === 0 ? [{ value: "clear", description: "remove attached images" }] : []),
    run: (app, args) => app.attachImage(args.join(" ")),
  },
  {
    name: "spawn",
    usage: "[on|off|add <cli> <model>|remove <cli> [model]|reset]",
    description: "The providers and models the orchestrator may spawn subagents with",
    group: "agents",
    complete: (app, i, before) => {
      if (i === 0)
        return [
          { value: "add", description: "allow a provider and model" },
          { value: "remove", description: "take one out" },
          { value: "reset", description: "back to your agents' models" },
          { value: "on", description: "let the orchestrator spawn" },
          { value: "off", description: "only configured agents" },
        ];
      if (i === 1 && (before[0] === "add" || before[0] === "remove")) return cliSuggestions(app);
      if (i === 2 && before[0] === "add") return modelSuggestions(app, before[1] ?? "");
      if (i === 2 && before[0] === "remove") return (spawnPool(app.cfg)[before[1] ?? ""] ?? []).map((value) => ({ value }));
      return [];
    },
    run: (app, args) => app.spawnCommand(args),
  },
  {
    name: "orchestrator",
    usage: "[setting value] | prompt",
    description: "See and change the orchestrator: model, effort, budget, turns, provider, instructions, prompt",
    group: "orchestrator",
    searchDescriptions: true,
    complete: (app, i, before) => {
      if (i === 0) return [...ORCHESTRATOR_FIELDS.map((f) => ({ value: f.name, description: `${f.show(app.cfg).split("\n")[0]!.slice(0, 40)} · ${f.about}` })), { value: "prompt", description: "show its full instructions" }];
      const f = fieldNamed(before[0] ?? "");
      if (i === 1 && f?.name === "model") return modelSuggestions(app, "claude", app.cfg.orchestrator.model);
      if (i === 1) return f?.values?.(app.cfg) ?? [];
      if (i === 2 && f?.name === "provider" && before[1] === "agent") return agentSuggestions(app);
      return [];
    },
    run: (app, args) => app.orchestratorCommand(args),
  },
  {
    name: "model",
    usage: "[name]",
    description: "Orchestrator model (plans, delegates, reviews)",
    group: "orchestrator",
    searchDescriptions: true,
    complete: (app, i) => (i === 0 ? modelSuggestions(app, "claude", app.cfg.orchestrator.model) : []),
    run: (app, [m]) => {
      if (!m) return app.note(`Orchestrator model: ${app.cfg.orchestrator.model}`);
      app.setConfig(["orchestrator", "model"], m);
      app.resetConversation();
      app.changed(`Orchestrator model is now ${m}. The next message starts a fresh conversation`);
    },
  },
  {
    name: "effort",
    usage: "[low|medium|high|xhigh|max|default]",
    description: "Orchestrator reasoning effort",
    group: "orchestrator",
    complete: (_app, i) => (i === 0 ? [...EFFORTS, { value: "default", description: "let the model decide" }] : []),
    run: (app, [v]) => {
      if (!v) return app.note(`Orchestrator effort: ${app.cfg.orchestrator.effort ?? "default"}`);
      if (v === "default") app.setConfig(["orchestrator", "effort"], undefined);
      else if (EFFORTS.some((e) => e.value === v)) app.setConfig(["orchestrator", "effort"], v);
      else return app.fail("usage: /effort low|medium|high|xhigh|max|default");
      app.changed(`Effort ${v}`);
    },
  },
  {
    name: "budget",
    usage: "[usd|off]",
    description: "Stop the orchestrator if one run spends more than this",
    group: "orchestrator",
    complete: (_app, i) => (i === 0 ? ["1", "2", "5", "10", "off"].map((v) => ({ value: v, description: v === "off" ? "no limit" : `$${v} per run` })) : []),
    run: (app, [v]) => {
      if (!v) return app.note(`Orchestrator budget: ${app.cfg.orchestrator.max_budget_usd !== undefined ? `$${app.cfg.orchestrator.max_budget_usd} per run` : "no limit"}`);
      if (v === "off") app.setConfig(["orchestrator", "max_budget_usd"], undefined);
      else {
        const n = Number(v.replace("$", ""));
        if (!(n > 0)) return app.fail("usage: /budget <usd> | off");
        app.setConfig(["orchestrator", "max_budget_usd"], n);
      }
      app.changed(v === "off" ? "No orchestrator budget" : `Orchestrator budget $${v.replace("$", "")} per run`);
    },
  },

  // ── agents ──
  { name: "agents", description: "List agents and their settings", group: "agents", run: (app) => app.listAgents() },
  {
    name: "models",
    usage: "[agent|cli] [search] | refresh",
    description: "Browse the models each agent CLI offers (from the CLIs)",
    group: "agents",
    complete: (app, i) =>
      i === 0
        ? [
            ...Object.entries(app.cfg.agents).map(([n, a]) => ({ value: n, description: `${a.cli} models` })),
            ...(["commandcode", "opencode", "claude"] as const).map((c) => ({ value: c, description: catalogStatus(app, c) ?? "" })),
            { value: "refresh", description: "ask every CLI again" },
          ]
        : [],
    run: (app, args) => app.showModels(args),
  },
  {
    name: "agent",
    usage: "<name> <field> <value> | new <name> <cli> [model] | remove <name>",
    description: "Change an agent (model, cli, role, instructions, timeout, permission, turns), add one, or remove one",
    group: "agents",
    needsArgs: true,
    searchDescriptions: true,
    complete: (app, i, before) => {
      if (i === 0)
        return [
          ...agentSuggestions(app),
          { value: "new", description: "add an agent: /agent new <name> <cli> [model]" },
          { value: "remove", description: "remove an agent" },
        ];
      if (before[0] === "new") {
        if (i === 2) return cliSuggestions(app);
        if (i === 3) return modelSuggestions(app, before[2] ?? "");
        return [];
      }
      if (before[0] === "remove") return i === 1 ? agentSuggestions(app) : [];
      const agent = app.cfg.agents[before[0] ?? ""];
      if (i === 1) return AGENT_FIELDS;
      if (i === 2 && before[1] === "permission")
        return [
          { value: "yolo", description: "no prompts (runs in its own worktree)" },
          { value: "accept-edits", description: "edits only" },
          { value: "plan", description: "read-only: reports, changes nothing" },
        ];
      if (i === 2 && before[1] === "model") return agent ? modelSuggestions(app, catalogKey(agent), agent.model) : [];
      if (i === 2 && before[1] === "cli") return cliSuggestions(app);
      if (i === 3 && before[1] === "cli") return modelSuggestions(app, before[2] ?? "");
      if (i === 2 && before[1] === "timeout") return ["5m", "15m", "30m", "1h"].map((v) => ({ value: v }));
      if (i === 2 && (before[1] === "role" || before[1] === "instructions")) return [{ value: "clear", description: `remove the ${before[1]}` }];
      return [];
    },
    run: (app, [name, field, ...rest]) => {
      const value = rest.join(" ").trim();
      if (name === "new") return newAgent(app, field, rest);
      if (name === "remove") return removeAgent(app, field);
      const agent = name ? app.cfg.agents[name] : undefined;
      if (!agent) return app.fail(name ? `unknown agent "${name}"` : `usage: /agent ${AGENT_USAGE}`, "type /agents to list them, or /agent new <name> <cli> to add one");
      switch (field) {
        case "model": {
          if (!value) return app.fail("usage: /agent <name> model <model>");
          app.setConfig(["agents", name!, "model"], value);
          app.changed(`${name} now uses ${value}`);
          warnUnknownModel(app, name!, catalogKey(agent), value);
          return;
        }
        case "cli": {
          const [cli, model] = rest;
          if (!cli) return app.fail("usage: /agent <name> cli <cli> [model]", `clis: ${switchableClis(app).join(", ")}`);
          if (!switchableClis(app).includes(cli)) return app.fail(`can't switch to cli "${cli}" here`, `clis: ${switchableClis(app).join(", ")}; acp and generic agents need a command (edit yxu.yaml, see docs/AGENTS.md)`);
          if (agent.command) return app.fail(`${name} is an ${agent.cli} agent with a command`, "change it in yxu.yaml");
          app.setConfig(["agents", name!, "cli"], cli);
          // Model ids differ between CLIs: keep the given one, else the CLI's default.
          app.setConfig(["agents", name!, "model"], model, model ?? null);
          app.changed(`${name} now runs on ${cli}${model ? ` with ${model}` : " (its default model; set one with /agent " + name + " model)"}`);
          if (model) warnUnknownModel(app, name!, cli, model);
          void app.catalog.refresh(cli).catch(() => {});
          return;
        }
        case "role":
        case "description":
          if (!value) return app.fail(`usage: /agent <name> role <when the orchestrator should use it> | clear`);
          app.setConfig(["agents", name!, "description"], value === "clear" ? undefined : value, value === "clear" ? null : value);
          return app.changed(value === "clear" ? `${name} has no role description` : `${name}'s role: ${value}`);
        case "instructions":
          if (!value) return app.note(agent.instructions ? `**${name}** instructions:\n\n${agent.instructions}` : `${name} has no instructions. Set them with /agent ${name} instructions <text>.`);
          app.setConfig(["agents", name!, "instructions"], value === "clear" ? undefined : value, value === "clear" ? null : value);
          return app.changed(value === "clear" ? `${name} has no instructions` : `${name}'s instructions updated`);
        case "timeout": {
          let ms: number;
          try {
            ms = parseDuration(value);
          } catch {
            return app.fail("usage: /agent <name> timeout <15m|90s|1h>");
          }
          app.setConfig(["agents", name!, "timeout"], ms, value);
          return app.changed(`${name} timeout ${value}`);
        }
        case "permission":
          if (!["yolo", "accept-edits", "plan"].includes(value)) return app.fail("usage: /agent <name> permission yolo|accept-edits|plan");
          app.setConfig(["agents", name!, "permission"], value);
          return app.changed(`${name} permission ${value}${value === "plan" ? " (read-only)" : ""}`);
        case "turns": {
          const n = Number(value);
          if (!(Number.isInteger(n) && n > 0)) return app.fail("usage: /agent <name> turns <n>");
          app.setConfig(["agents", name!, "max_turns"], n);
          return app.changed(`${name} max turns ${n}`);
        }
        default:
          return app.fail(`usage: /agent ${AGENT_USAGE}`, `fields: ${AGENT_FIELDS.map((f) => f.value).join(", ")}`);
      }
    },
  },
  {
    name: "concurrency",
    usage: "[n]",
    description: "How many subagents may run at the same time",
    group: "agents",
    complete: (_app, i) => (i === 0 ? ["1", "2", "3", "4", "6", "8"].map((v) => ({ value: v })) : []),
    run: (app, [v]) => {
      if (!v) return app.note(`Concurrency: ${app.cfg.settings.concurrency}`);
      const n = Number(v);
      if (!(Number.isInteger(n) && n >= 1 && n <= 16)) return app.fail("usage: /concurrency <1–16>");
      app.setConfig(["settings", "concurrency"], n);
      app.changed(`Up to ${n} subagents at once`);
    },
  },
  {
    name: "resolver",
    usage: "[agent|off]",
    description: "Agent that resolves merge conflicts when combining work",
    group: "agents",
    complete: (app, i) => (i === 0 ? [...agentSuggestions(app), { value: "off", description: "conflicts fail instead" }] : []),
    run: (app, [v]) => {
      if (!v) return app.note(`Conflict resolver: ${app.cfg.settings.resolver ?? "none"}`);
      if (v === "off") app.setConfig(["settings", "resolver"], undefined);
      else if (!app.cfg.agents[v]) return app.fail(`unknown agent "${v}"`);
      else app.setConfig(["settings", "resolver"], v);
      app.changed(v === "off" ? "No conflict resolver" : `${v} resolves conflicts`);
    },
  },
  {
    name: "verify",
    usage: "[command|off]",
    description: "Test command that checks results (verify steps and tool)",
    group: "agents",
    complete: (app, i) =>
      i === 0 ? [app.cfg.settings.verify, "npm test", "bun test", "python -m pytest -q", "cargo test", "go test ./...", "off"].filter((v): v is string => !!v).map((v) => ({ value: v })) : [],
    run: (app, args) => {
      const v = args.join(" ").trim();
      if (!v) return app.note(`Verify command: ${app.cfg.settings.verify ?? "none"}`);
      app.setConfig(["settings", "verify"], v === "off" ? undefined : v);
      app.changed(v === "off" ? "Verification off" : `Verify with \`${v}\``);
    },
  },

  // ── context ──
  {
    name: "context",
    usage: "[option]",
    description: "What the orchestrator sees: memory, CLAUDE.md, files, notes",
    group: "context",
    complete: (app, i, before) => {
      if (i === 0)
        return [
          { value: "show", description: "full context report" },
          { value: "memory", description: "continue one conversation, or start fresh each message" },
          { value: "instructions", description: "load CLAUDE.md or not" },
          { value: "add", description: "add a repo file to every run" },
          { value: "drop", description: "remove an added file" },
          { value: "notes", description: "standing notes for the orchestrator" },
          { value: "save", description: "save to yxu.yaml (or: save local / save user)" },
        ];
      if (i === 1 && (before[0] === "memory" || before[0] === "instructions")) return ON_OFF;
      if (i === 1 && before[0] === "drop") return app.cfg.context.include.map((f) => ({ value: f }));
      if (i === 1 && before[0] === "notes") return [{ value: "clear", description: "remove notes" }];
      if (i === 1 && before[0] === "save") return SAVE_TARGETS;
      return [];
    },
    run: (app, args) => app.contextCommand(args),
  },
  {
    name: "compact",
    usage: "[text|option]",
    description: "Summarize the conversation now, or configure auto-compaction",
    group: "context",
    complete: (_app, i, before) => {
      if (i === 0)
        return [
          { value: "auto", description: "auto-compaction on/off" },
          { value: "window", description: "window to compact against (100k–1m, auto)" },
          { value: "instructions", description: "what summaries must keep" },
          { value: "warn", description: "warn at this % of the window" },
          { value: "background", description: "compact between turns without blocking: on|off, or start at % of the window" },
        ];
      if (i === 1 && before[0] === "auto") return ON_OFF;
      if (i === 1 && before[0] === "background") return [...ON_OFF, ...["50%", "60%", "70%"].map((v) => ({ value: v, description: "start at this % of the window" }))];
      if (i === 1 && before[0] === "window") return ["auto", "200k", "400k", "1m"].map((v) => ({ value: v }));
      if (i === 1 && before[0] === "warn") return ["70%", "80%", "90%"].map((v) => ({ value: v }));
      return [];
    },
    run: (app, args) => app.compactCommand(args),
  },

  // ── tasks ──
  { name: "tasks", description: "List tasks in this session", group: "tasks", run: (app) => app.listTasks() },
  {
    name: "diff",
    usage: "<task>",
    description: "Show a task's changes",
    group: "tasks",
    needsArgs: true,
    complete: (app, i) => (i === 0 ? taskSuggestions(app, false) : []),
    run: (app, [id]) => app.taskAction("diff", id),
  },
  {
    name: "apply",
    usage: "<task>",
    description: "Bring a task's changes into your working tree (uncommitted; /undo puts it back)",
    group: "tasks",
    needsArgs: true,
    complete: (app, i) => (i === 0 ? taskSuggestions(app, true) : []),
    run: (app, [id]) => app.taskAction("apply", id),
  },
  {
    name: "sessions",
    usage: "[all|here]",
    description: "Saved sessions: this repo's, every repo's (all), or this folder's (here)",
    group: "session",
    complete: (_app, i) => (i === 0 ? [{ value: "all", description: "every repository" }, { value: "here", description: "started in this folder" }] : []),
    run: (app, [arg]) => app.listSessionsCommand(arg ?? ""),
  },
  {
    name: "resume",
    usage: "<session|last>",
    description: "Continue a saved session of this repo: its conversation and pending results",
    group: "session",
    complete: (app, i) => (i === 0 ? sessionSuggestions(app) : []),
    run: (app, [id]) => app.resumeCommand(id ?? ""),
  },
  { name: "rename", usage: "[title]", description: "Name this session (shown by /sessions and yxu sessions)", group: "session", run: (app, args) => app.renameSession(args.join(" ")) },
  {
    name: "watch",
    usage: "[task|off]",
    description: "Watch a running agent live in the side panel: its tool calls and diff",
    group: "tasks",
    complete: (_app, i) => (i === 0 ? [...liveSuggestions(), { value: "off", description: "stop watching" }] : []),
    run: (app, [arg]) => app.watchCommand(arg ?? ""),
  },
  {
    name: "tell",
    usage: "[task] <message>",
    description: "Send a running agent a correction; it continues with it, keeping its work",
    group: "tasks",
    needsArgs: true,
    complete: (_app, i) => (i === 0 ? liveSuggestions() : []),
    run: (app, args) => app.tell(args),
  },
  { name: "pause", usage: "[task]", description: "Pause a running agent (its timeout too)", group: "tasks", complete: (_app, i) => (i === 0 ? liveSuggestions() : []), run: (app, [id]) => app.liveAction("pause", id) },
  { name: "continue", usage: "[task]", description: "Let a paused agent go on", group: "tasks", complete: (_app, i) => (i === 0 ? liveSuggestions() : []), run: (app, [id]) => app.liveAction("resume", id) },
  {
    name: "takeover",
    usage: "[task]",
    description: "Stop the agent and finish its task yourself in its worktree (/done hands it back)",
    group: "tasks",
    complete: (_app, i) => (i === 0 ? liveSuggestions() : []),
    run: (app, [id]) => app.liveAction("takeover", id),
  },
  { name: "done", usage: "[task]", description: "Hand a task you took over back to the orchestrator", group: "tasks", complete: (_app, i) => (i === 0 ? liveSuggestions() : []), run: (app, [id]) => app.liveAction("done", id) },
  {
    name: "map",
    usage: "[words]",
    description: "The repo map agents share: its overview, or what it finds for some words",
    group: "context",
    run: (app, args) => void app.showMap(args.join(" ")),
  },
  {
    name: "pr",
    usage: "<task> [--draft] [--base branch] [--title text]",
    description: "Push a task and open a pull request (agents' work, checks, reviews, issue)",
    group: "tasks",
    needsArgs: true,
    complete: (app, i) => (i === 0 ? taskSuggestions(app, true) : [{ value: "--draft" }, { value: "--base" }, { value: "--title" }]),
    run: (app, args) => {
      const [id, ...rest] = args;
      const o: { draft?: boolean; base?: string; title?: string } = {};
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--draft") o.draft = true;
        else if (rest[i] === "--base") o.base = rest[++i];
        else if (rest[i] === "--title") {
          o.title = rest.slice(i + 1).join(" ");
          break;
        }
      }
      const task = app.resolveTask(id ?? "");
      if (!task) return app.fail(id ? `no task matching "${id}"` : "usage: /pr <task> [--draft] [--base branch] [--title text]", "type /tasks to list task ids");
      app.pullRequest(task, o);
    },
  },
  {
    name: "issue",
    usage: "<123 | owner/repo#123 | url | linear:ENG-12> [more instructions]",
    description: "Work on an issue: its text, comments and files become the goal",
    group: "tasks",
    needsArgs: true,
    run: (app, args) => void app.startIssue(args.join(" ")),
  },
  {
    name: "fix-ci",
    usage: "<pr> [agent]",
    description: "Fix a pull request's failing CI on its branch (asks before pushing)",
    group: "tasks",
    needsArgs: true,
    complete: (app, i) => (i === 1 ? agentSuggestions(app) : []),
    run: (app, [pr, agent]) => void app.fixCi(pr ?? "", agent),
  },
  {
    name: "undo",
    description: "Put back what the last apply changed in your working tree",
    group: "tasks",
    run: (app) => app.undoApply(),
  },
  {
    name: "discard",
    usage: "<task>",
    description: "Throw a task's changes away",
    group: "tasks",
    needsArgs: true,
    complete: (app, i) => (i === 0 ? taskSuggestions(app, true) : []),
    run: (app, [id]) => app.taskAction("discard", id),
  },

  // ── interface ──
  {
    name: "panel",
    usage: "[on|off]",
    description: "Show or hide the context panel",
    group: "interface",
    complete: (_app, i) => (i === 0 ? ON_OFF : []),
    run: (app, [v]) => app.store.set({ panelOpen: onOff(v) ?? !app.store.state.panelOpen }),
  },
  {
    name: "theme",
    usage: "[name]",
    description: "Switch the color theme, or list themes",
    group: "interface",
    complete: (app, i) =>
      i === 0 ? [...Object.entries(BUILTIN_THEMES).map(([n, t]) => ({ value: n, description: t.about })), ...themeFiles(app.root).map((n) => ({ value: n, description: "theme file" }))] : [],
    run: (app, [name]) => (name ? app.switchTheme(name) : app.listThemes()),
  },
  {
    name: "keys",
    description: "Show the key bindings (rebind them with ui.keys)",
    group: "interface",
    run: (app) => app.showKeys(),
  },
  {
    name: "motion",
    usage: "on|off",
    description: "Pulse animation (off = reduced motion)",
    group: "interface",
    complete: (_app, i) => (i === 0 ? ON_OFF : []),
    run: (app, [v]) => {
      const on = onOff(v) ?? app.theme.reducedMotion;
      app.setTheme({ reducedMotion: !on });
      app.note(`Motion ${on ? "on" : "off (reduced motion)"}`);
    },
  },
  {
    name: "ascii",
    usage: "on|off",
    description: "ASCII-only glyphs for limited terminals",
    group: "interface",
    complete: (_app, i) => (i === 0 ? ON_OFF : []),
    run: (app, [v]) => {
      const on = onOff(v) ?? !app.theme.ascii;
      app.setTheme({ ascii: on });
      app.note(`ASCII glyphs ${on ? "on" : "off"}`);
    },
  },
];

/** Built-in commands plus the user's own (.yxu/commands), as one list. */
export function allCommands(app?: App): Command[] {
  const fromPlugins = (app?.cfg.plugins?.commands ?? []).map(
    ({ plugin, command }): Command => ({
      name: `${plugin}:${command.name}`,
      usage: command.usage,
      description: `${command.description ?? ""} (plugin ${plugin})`.trim(),
      group: "custom",
      run: (a, args) => a.runPluginCommand(plugin, command, args),
    }),
  );
  return [...COMMANDS, ...(app?.userCommands ?? []).map(customCommand), ...fromPlugins];
}

function customCommand(c: UserCommand): Command {
  return {
    name: c.name,
    usage: commandUsage(c) || undefined,
    description: `${c.description}${c.kind === "prompt" ? "" : ` (${c.kind})`}`,
    group: "custom",
    needsArgs: c.args.some((a) => a.required),
    complete: (app, i) => {
      // The last arg takes the rest of the line, so keep completing it.
      const a = c.args[Math.min(i, c.args.length - 1)];
      if (!a || (i >= c.args.length && a.complete !== "file")) return [];
      if (a.complete === "agent") return Object.entries(app.cfg.agents).map(([n, x]) => ({ value: n, description: `${x.cli} · ${x.model ?? "default"}` }));
      if (a.complete === "workflow") return Object.entries(app.cfg.workflows).map(([n, w]) => ({ value: n, description: w.description ?? w.mode }));
      return [];
    },
    run: (app, args) => app.runUserCommand(c, args),
  };
}

export function findCommand(name: string, app?: App): Command | undefined {
  const n = name.toLowerCase();
  return allCommands(app).find((c) => c.name === n || c.aliases?.includes(n));
}

/** Split a command line into name and arguments ("/agent coder model x/y"). */
export function parseCommandLine(line: string): { name: string; args: string[] } {
  const [name = "", ...args] = line.trim().slice(1).split(/\s+/).filter(Boolean);
  return { name, args };
}

export interface PaletteState {
  items: Suggestion[];
  selected: number;
  /** "command": completing the command name; "arg": completing an argument. */
  mode: "command" | "arg";
  /** Command whose arguments are being completed (arg mode). */
  command?: string;
  /** Usage hint for the current command. */
  hint?: string;
  /** Extra status line, e.g. "loading models from opencode…". */
  status?: string;
}

/**
 * Rank suggestions for a typed prefix: exact match (or exact short name after the last "/"),
 * then prefix, then substring, then (optionally) description matches. Stable within a rank.
 */
function rank(items: Suggestion[], prefix: string, key: (s: Suggestion) => string, searchDescriptions = false): Suggestion[] {
  const p = prefix.toLowerCase();
  if (!p) return items;
  const score = (s: Suggestion): number => {
    const k = key(s).toLowerCase();
    const short = k.slice(k.lastIndexOf("/") + 1);
    if (k === p || short === p) return 0;
    if (k.startsWith(p) || short.startsWith(p)) return 1;
    if (k.includes(p)) return 2;
    if (searchDescriptions && p.length >= 3 && (s.description ?? "").toLowerCase().includes(p)) return 3;
    return 9;
  };
  return items
    .map((s, i) => ({ s, i, r: score(s) }))
    .filter((x) => x.r < 9)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}

/** True when argument `i` of a custom command completes repo files. */
function fileArg(app: App, cmd: Command, i: number): boolean {
  if (cmd.group !== "custom") return false;
  const c = app.userCommands.find((u) => u.name === cmd.name);
  const a = c?.args[Math.min(i, (c?.args.length ?? 1) - 1)];
  return a?.complete === "file";
}

/** What the palette should show for the current draft, or undefined when it shouldn't open. */
export function paletteFor(app: App, text: string): PaletteState | undefined {
  if (!text.startsWith("/") || text.includes("\n")) return undefined;
  const body = text.slice(1);
  const space = body.search(/\s/);
  if (space === -1) {
    const items = rank(
      allCommands(app).map((c) => ({ value: c.name, label: `/${c.name}${c.usage ? ` ${c.usage}` : ""}`, description: c.description })),
      body,
      (s) => s.value,
      true,
    );
    return items.length ? { items, selected: 0, mode: "command" } : undefined;
  }
  const cmd = findCommand(body.slice(0, space), app);
  if (!cmd) return undefined;
  const parts = body.slice(space).split(/\s+/);
  parts.shift(); // leading empty from the separator
  const current = parts.pop() ?? "";
  const before = parts;
  // /context add <file> completes from the repository.
  const raw =
    (cmd.name === "context" && before.length === 1 && before[0] === "add") || fileArg(app, cmd, before.length)
      ? fileSuggestions(app, current)
      : (cmd.complete?.(app, before.length, before) ?? []);
  const items = rank(raw, current, (s) => s.value, cmd.searchDescriptions).filter((s) => s.value !== current || raw.length > 1);
  const hint = `/${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ""} — ${cmd.description}`;
  const modelCli =
    cmd.name === "model" && before.length === 0
      ? "claude"
      : cmd.name === "agent" && ((before.length === 3 && before[1] === "cli") || (before.length === 3 && before[0] === "new"))
        ? before[2]
        : cmd.name === "agent" && before.length === 2 && before[1] === "model"
        ? (() => {
            const a = app.cfg.agents[before[0] ?? ""];
            return a ? catalogKey(a) : undefined;
          })()
        : undefined;
  const status = modelCli ? catalogStatus(app, modelCli) : undefined;
  return { items, selected: 0, mode: "arg", command: cmd.name, hint, status };
}

function doctor(app: App) {
  const bins: [string, string][] = [
    ["commandcode", "cmd"],
    ["opencode", "opencode"],
    ["claude", "claude"],
  ];
  const lines = bins.map(([cli, bin]) => {
    const path = which(bin);
    if (!path) return `- ✗ **${cli}** — \`${bin}\` not found on PATH`;
    const args = cli === "commandcode" ? ["--version", "--no-auto-update"] : ["--version"];
    const v = spawnSync(bin, args, { encoding: "utf8", timeout: 5000 }).stdout?.trim().split("\n").at(-1) ?? "?";
    const used = Object.entries(app.cfg.agents).filter(([, a]) => a.cli === cli).map(([n]) => n);
    return `- ✓ **${cli}** ${v}${used.length ? ` — used by ${used.join(", ")}` : ""}`;
  });
  app.note(`Agent CLIs\n${lines.join("\n")}`);
}

