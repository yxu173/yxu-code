/**
 * Slash commands: one registry drives execution, the `/` palette, argument completion, and help.
 * Every command is a thin layer over App methods; nothing here talks to agents directly.
 */
import { spawnSync } from "node:child_process";
import { parseDuration } from "../config.ts";
import { tryGit } from "../git.ts";
import { which } from "../platform.ts";
import type { CliName } from "../types.ts";
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
  group: "session" | "orchestrator" | "agents" | "context" | "tasks" | "interface";
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
function modelSuggestions(app: App, cli: CliName, current?: string): Suggestion[] {
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
export function catalogStatus(app: App, cli: CliName): string | undefined {
  const st = app.catalog.get(cli);
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
  { name: "new", description: "Start a fresh orchestrator conversation", group: "session", run: (app) => app.newConversation() },
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
    name: "workflow",
    usage: "[name]",
    description: "Show or switch the workflow",
    group: "orchestrator",
    complete: (app, i) =>
      i === 0 ? Object.entries(app.cfg.workflows).map(([n, w]) => ({ value: n, description: `${w.mode}${w.steps ? ` · ${w.steps.map((s) => s.id).join(" → ")}` : ""}` })) : [],
    run: (app, args) => app.switchWorkflow(args.join(" ").trim()),
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
    usage: "<name> <model|timeout|permission|turns> <value>",
    description: "Change one agent's model, timeout, permission, or turn limit",
    group: "agents",
    needsArgs: true,
    searchDescriptions: true,
    complete: (app, i, before) => {
      if (i === 0) return agentSuggestions(app);
      if (i === 1)
        return [
          { value: "model", description: "model the agent's CLI uses" },
          { value: "timeout", description: "e.g. 15m, 90s" },
          { value: "permission", description: "yolo | accept-edits | plan" },
          { value: "turns", description: "max turns per task" },
        ];
      if (i === 2 && before[1] === "permission")
        return [
          { value: "yolo", description: "no prompts (runs in its own worktree)" },
          { value: "accept-edits", description: "edits only" },
          { value: "plan", description: "read-only" },
        ];
      if (i === 2 && before[1] === "model") {
        const agent = app.cfg.agents[before[0] ?? ""];
        return agent ? modelSuggestions(app, agent.cli, agent.model) : [];
      }
      if (i === 2 && before[1] === "timeout") return ["5m", "15m", "30m", "1h"].map((v) => ({ value: v }));
      return [];
    },
    run: (app, [name, field, ...rest]) => {
      const value = rest.join(" ").trim();
      const agent = name ? app.cfg.agents[name] : undefined;
      if (!agent) return app.fail(name ? `unknown agent "${name}"` : "usage: /agent <name> <model|timeout|permission|turns> <value>", "type /agents to list them");
      switch (field) {
        case "model": {
          if (!value) return app.fail("usage: /agent <name> model <model>");
          const known = app.catalog.get(agent.cli);
          app.setConfig(["agents", name!, "model"], value);
          app.changed(`${name} now uses ${value}`);
          // Short names (e.g. "kimi-k2.5") are valid for some CLIs, so this only warns.
          if (known.status === "ready" && known.models.length && !known.models.some((m) => m.id === value || m.id.endsWith(`/${value}`))) {
            app.note(`${value} is not in the ${known.models.length} models ${agent.cli} reported. If the agent fails, pick one with /agent ${name} model.`, "attention");
          }
          return;
        }
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
          return app.changed(`${name} permission ${value}`);
        case "turns": {
          const n = Number(value);
          if (!(Number.isInteger(n) && n > 0)) return app.fail("usage: /agent <name> turns <n>");
          app.setConfig(["agents", name!, "max_turns"], n);
          return app.changed(`${name} max turns ${n}`);
        }
        default:
          return app.fail("usage: /agent <name> <model|timeout|permission|turns> <value>");
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
        ];
      if (i === 1 && before[0] === "auto") return ON_OFF;
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
    description: "Merge a task into your branch",
    group: "tasks",
    needsArgs: true,
    complete: (app, i) => (i === 0 ? taskSuggestions(app, true) : []),
    run: (app, [id]) => app.taskAction("apply", id),
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

export function findCommand(name: string): Command | undefined {
  const n = name.toLowerCase();
  return COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
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

/** What the palette should show for the current draft, or undefined when it shouldn't open. */
export function paletteFor(app: App, text: string): PaletteState | undefined {
  if (!text.startsWith("/") || text.includes("\n")) return undefined;
  const body = text.slice(1);
  const space = body.search(/\s/);
  if (space === -1) {
    const items = rank(
      COMMANDS.map((c) => ({ value: c.name, label: `/${c.name}${c.usage ? ` ${c.usage}` : ""}`, description: c.description })),
      body,
      (s) => s.value,
      true,
    );
    return items.length ? { items, selected: 0, mode: "command" } : undefined;
  }
  const cmd = findCommand(body.slice(0, space));
  if (!cmd) return undefined;
  const parts = body.slice(space).split(/\s+/);
  parts.shift(); // leading empty from the separator
  const current = parts.pop() ?? "";
  const before = parts;
  // /context add <file> completes from the repository.
  const raw =
    cmd.name === "context" && before.length === 1 && before[0] === "add"
      ? fileSuggestions(app, current)
      : (cmd.complete?.(app, before.length, before) ?? []);
  const items = rank(raw, current, (s) => s.value, cmd.searchDescriptions).filter((s) => s.value !== current || raw.length > 1);
  const hint = `/${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ""} — ${cmd.description}`;
  const modelCli =
    cmd.name === "model" && before.length === 0
      ? "claude"
      : cmd.name === "agent" && before.length === 2 && before[1] === "model"
        ? app.cfg.agents[before[0] ?? ""]?.cli
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

