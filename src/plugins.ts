/**
 * Finding, approving and loading plugins (see plugin-api.ts for what a plugin can do).
 *
 *   ~/.config/yxu/packs/<pack>/plugins/   user packs      loaded (you installed them)
 *   ~/.config/yxu/plugins/                yours           loaded
 *   <repo>/.yxu/packs/<pack>/plugins/     project packs   loaded once you approve them
 *   <repo>/.yxu/plugins/                  the repo's      loaded once you approve them
 *
 * A plugin is `<name>.ts` / `.js` / `.mjs`, or a folder with `index.ts` / `index.js`.
 * Approvals are stored per plugin path with a hash of its code in ~/.config/yxu/plugins.json,
 * so a changed plugin needs approving again. YXU_TRUST=1 (CI) approves everything.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { userConfigDir } from "./config-layers.ts";
import { installedPacks } from "./packs.ts";
import { PLUGIN_API_VERSION, type Plugin, type PluginAgent, type PluginCommand, type PluginContext, type PluginHooks, type PluginOrchestrator, type PluginPanel } from "./plugin-api.ts";
import { shellArgv, start } from "./platform.ts";
import { integrity } from "./sources.ts";

export type PluginScope = "user" | "project";
export type PluginStatus = "loaded" | "pending" | "changed" | "error";

export interface PluginEntry {
  /** The file or folder name (before loading, the only name known). */
  id: string;
  /** The module yxu imports. */
  file: string;
  /** What approval covers: the file, or the plugin's folder. */
  path: string;
  scope: PluginScope;
  pack?: string;
  status: PluginStatus;
  error?: string;
  plugin?: Plugin;
}

export interface PluginRegistry {
  entries: PluginEntry[];
  commands: { plugin: string; command: PluginCommand }[];
  panels: { plugin: string; panel: PluginPanel }[];
  hooks: { plugin: string; hooks: PluginHooks }[];
  agents: Map<string, { plugin: string; agent: PluginAgent }>;
  orchestrators: Map<string, { plugin: string; orchestrator: PluginOrchestrator }>;
}

export const emptyRegistry = (): PluginRegistry => ({ entries: [], commands: [], panels: [], hooks: [], agents: new Map(), orchestrators: new Map() });

const NAME = /^[a-z][a-z0-9-]*$/;
const ENTRY = /^([a-z][a-z0-9-]*)\.(ts|js|mjs)$/;

/** Plugin modules in one folder. */
function scan(dir: string): { id: string; file: string; path: string }[] {
  if (!existsSync(dir)) return [];
  const out: { id: string; file: string; path: string }[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const m = ENTRY.exec(name);
    if (m && statSync(p).isFile()) out.push({ id: m[1]!, file: p, path: p });
    else if (NAME.test(name) && statSync(p).isDirectory()) {
      const index = ["index.ts", "index.js", "index.mjs"].map((f) => join(p, f)).find(existsSync);
      if (index) out.push({ id: name, file: index, path: p });
    }
  }
  return out;
}

/** Plugin files and folders directly in `dir` (e.g. a pack's plugins/). */
export const pluginsIn = (dir: string) => scan(dir);

/** Every plugin location for a repo, in load order. */
export function discoverPlugins(root: string): Omit<PluginEntry, "status">[] {
  const at = (scope: PluginScope, dir: string, pack?: string) => scan(dir).map((x) => ({ ...x, scope, pack }));
  return [
    ...installedPacks("user", root).flatMap((p) => at("user", join(p.dir, "plugins"), p.name)),
    ...at("user", join(userConfigDir(), "plugins")),
    ...installedPacks("project", root).flatMap((p) => at("project", join(p.dir, "plugins"), p.name)),
    ...at("project", join(root, ".yxu", "plugins")),
  ];
}

// ── approvals ────────────────────────────────────────────────────────────────

const approvalsFile = () => join(userConfigDir(), "plugins.json");
type Approvals = { approved: Record<string, { integrity: string; at: string }> };

function readApprovals(): Approvals {
  try {
    return existsSync(approvalsFile()) ? (JSON.parse(readFileSync(approvalsFile(), "utf8")) as Approvals) : { approved: {} };
  } catch {
    return { approved: {} };
  }
}

/** The real path, even for a path that doesn't exist yet (its closest existing parent is resolved). */
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(real(parent), basename(p));
  }
};

/** Approve (or forget) a plugin at its current code (or at the code in `contentFrom`, before it is copied there). */
export function setApproval(path: string, approved: boolean, contentFrom = path) {
  const a = readApprovals();
  if (approved) a.approved[real(path)] = { integrity: integrity(contentFrom), at: new Date().toISOString() };
  else delete a.approved[real(path)];
  mkdirSync(dirname(approvalsFile()), { recursive: true });
  writeFileSync(approvalsFile(), `${JSON.stringify(a, null, 2)}\n`);
}

function approvalState(entry: { path: string; scope: PluginScope }, env: NodeJS.ProcessEnv): "ok" | "pending" | "changed" {
  if (entry.scope === "user" || env.YXU_TRUST === "1") return "ok";
  const a = readApprovals().approved[real(entry.path)];
  if (!a) return "pending";
  return a.integrity === integrity(entry.path) ? "ok" : "changed";
}

// ── loading ──────────────────────────────────────────────────────────────────

const loaded = new Map<string, { hash: string; plugin: Plugin }>();

/** Check a module's default export against the API. */
export function checkPlugin(mod: unknown, file: string): Plugin {
  const p = ((mod as { default?: unknown })?.default ?? mod) as Partial<Plugin>;
  const bad = (msg: string) => new Error(`${file}: ${msg}`);
  if (!p || typeof p !== "object") throw bad("the default export must be a plugin object ({ name, apiVersion: 1, … })");
  if (typeof p.name !== "string" || !NAME.test(p.name)) throw bad("name must be lowercase words, e.g. jira");
  if (p.apiVersion !== PLUGIN_API_VERSION) {
    throw bad(typeof p.apiVersion === "number" && p.apiVersion > PLUGIN_API_VERSION ? `needs plugin API ${p.apiVersion}; this yxu has ${PLUGIN_API_VERSION} (run \`yxu update\`)` : `apiVersion must be ${PLUGIN_API_VERSION}`);
  }
  const list = <T>(v: T[] | undefined, what: string, check: (x: T) => string | undefined) => {
    if (v === undefined) return;
    if (!Array.isArray(v)) throw bad(`${what} must be a list`);
    for (const x of v) {
      const err = check(x);
      if (err) throw bad(`${what}: ${err}`);
    }
  };
  list(p.commands, "commands", (c) => (!c || !NAME.test(c.name) ? `command names are lowercase words (got ${JSON.stringify(c?.name)})` : typeof c.run !== "function" ? `/${c.name} needs run(ctx, args)` : undefined));
  list(p.panel, "panel", (s) => (!s || typeof s.title !== "string" || !s.title ? "each section needs a title" : typeof s.render !== "function" ? `section ${s.title} needs render(ctx)` : undefined));
  list(p.agents, "agents", (a) => (!a || !NAME.test(a.cli) ? "each agent needs a cli name (lowercase words)" : ["commandcode", "opencode", "claude", "acp", "generic"].includes(a.cli) ? `cli "${a.cli}" is built in` : typeof a.command !== "function" || typeof a.parse !== "function" ? `agent ${a.cli} needs command() and parse()` : undefined));
  list(p.orchestrators, "orchestrators", (o) => (!o || !NAME.test(o.name) ? "each orchestrator needs a name" : ["claude", "agent"].includes(o.name) ? `orchestrator "${o.name}" is built in` : typeof o.ask !== "function" ? `orchestrator ${o.name} needs ask()` : undefined));
  if (p.hooks !== undefined && (typeof p.hooks !== "object" || Object.entries(p.hooks).some(([k, f]) => typeof f !== "function" || !["before_run", "after_task", "before_apply", "on_failure", "on_complete"].includes(k)))) {
    throw bad("hooks must map before_run, after_task, before_apply, on_failure or on_complete to functions");
  }
  return p as Plugin;
}

function importPlugin(file: string, hash: string): Plugin {
  const hit = loaded.get(file);
  if (hit?.hash === hash) return hit.plugin;
  // Changed on disk: drop it (and its folder's modules) from the module cache first.
  const dir = dirname(file);
  for (const k of Object.keys(require.cache)) if (k === file || k.startsWith(`${dir}/`)) delete require.cache[k];
  const plugin = checkPlugin(require(file), file);
  loaded.set(file, { hash, plugin });
  return plugin;
}

/** Find, check approvals for, and load every plugin for a repo. Never throws; problems are in entries. */
export function loadPlugins(root: string, env: NodeJS.ProcessEnv = process.env): PluginRegistry {
  const reg = emptyRegistry();
  for (const d of discoverPlugins(root)) {
    const entry: PluginEntry = { ...d, status: "error" };
    reg.entries.push(entry);
    try {
      const state = approvalState(d, env);
      if (state !== "ok") {
        entry.status = state;
        continue;
      }
      const plugin = importPlugin(d.file, integrity(d.path));
      const clash = reg.entries.find((e) => e !== entry && e.plugin?.name === plugin.name);
      if (clash) throw new Error(`another plugin is already named ${plugin.name} (${clash.file})`);
      for (const a of plugin.agents ?? []) {
        const other = reg.agents.get(a.cli);
        if (other) throw new Error(`agent cli "${a.cli}" is already added by plugin ${other.plugin}`);
      }
      for (const o of plugin.orchestrators ?? []) {
        const other = reg.orchestrators.get(o.name);
        if (other) throw new Error(`orchestrator "${o.name}" is already added by plugin ${other.plugin}`);
      }
      entry.plugin = plugin;
      entry.status = "loaded";
      for (const c of plugin.commands ?? []) reg.commands.push({ plugin: plugin.name, command: c });
      for (const s of plugin.panel ?? []) reg.panels.push({ plugin: plugin.name, panel: s });
      if (plugin.hooks) reg.hooks.push({ plugin: plugin.name, hooks: plugin.hooks });
      for (const a of plugin.agents ?? []) reg.agents.set(a.cli, { plugin: plugin.name, agent: a });
      for (const o of plugin.orchestrators ?? []) reg.orchestrators.set(o.name, { plugin: plugin.name, orchestrator: o });
    } catch (e) {
      entry.status = "error";
      entry.error = (e as Error).message;
    }
  }
  current = reg;
  return reg;
}

/** The registry from the most recent config load (adapters and hooks look things up here). */
let current: PluginRegistry = emptyRegistry();
export const plugins = (): PluginRegistry => current;

// ── context ──────────────────────────────────────────────────────────────────

/** What the host (interface or CLI) lets plugins do. */
export interface PluginHost {
  note(markdown: string): void;
  run(goal: string, opts?: { workflow?: string; inputs?: Record<string, string> }): Promise<{ ok: boolean; result: string }>;
}

let host: PluginHost = {
  note: (m) => console.error(m),
  run: async () => {
    throw new Error("plugins can't start runs here");
  },
};
export const setPluginHost = (h: PluginHost) => {
  host = h;
};

export function pluginContext(plugin: string, root: string, config: Record<string, unknown>): PluginContext {
  const dataFile = join(root, ".yxu", "plugin-data", `${plugin}.json`);
  const readData = (): Record<string, unknown> => {
    try {
      return existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, "utf8")) : {};
    } catch {
      return {};
    }
  };
  return {
    plugin,
    root,
    config: Object.freeze(structuredClone(config)),
    note: (m) => host.note(m),
    run: (goal, opts) => host.run(goal, opts),
    shell: async (command, opts = {}) => {
      const child = start(shellArgv(command), { cwd: opts.cwd ?? root });
      const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
      const r = await child.result;
      if (timer) clearTimeout(timer);
      return r;
    },
    data: {
      get: <T>(key: string) => readData()[key] as T | undefined,
      set: (key, value) => {
        const d = readData();
        d[key] = value;
        mkdirSync(dirname(dataFile), { recursive: true });
        writeFileSync(dataFile, `${JSON.stringify(d, null, 2)}\n`);
      },
    },
  };
}
