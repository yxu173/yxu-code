/**
 * Configuration layers, merged in order (later wins; maps merge deeply, lists replace):
 *
 *   defaults   built-in schema defaults (+ the starter agents/workflows while no file defines agents)
 *   user       ~/.config/yxu/config.yaml        personal, every repo
 *   project    <repo>/yxu.yaml                  team, committed
 *   local      <repo>/yxu.local.yaml            personal for this repo, git-ignored
 *   env        YXU_ORCHESTRATOR_MODEL=sonnet …  (orchestrator/settings/context/compact keys)
 *   flags      --set key=value, --model, --budget
 *
 * A value of `null` removes what lower layers set (e.g. `agents: { heavy-coder: null }`).
 * An agent whose `cli` changes is replaced as a whole, so options for the old CLI don't leak.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONFIG_VERSION, DEFAULT_YAML, validateConfig, type Config } from "./config.ts";

export const LAYERS = ["defaults", "user", "project", "local", "env", "flags"] as const;
export type LayerName = (typeof LAYERS)[number];
export const FILE_LAYERS = ["user", "project", "local"] as const;
export type FileLayer = (typeof FILE_LAYERS)[number];

export interface LayerInfo {
  name: LayerName;
  /** Config file for file layers (whether or not it exists). */
  file?: string;
  exists: boolean;
  /** `version:` written in the file (undefined: not set). */
  version?: number;
  data: Record<string, unknown>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** ~/.config/yxu (or $XDG_CONFIG_HOME/yxu): personal config, workflows, commands, prompts, themes. */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "yxu");
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(userConfigDir(env), "config.yaml");
}

/** Where each file layer lives for a repo (yxu.yml is accepted for the project file). */
export function layerPaths(root: string, env: NodeJS.ProcessEnv = process.env): Record<FileLayer, string> {
  const yml = join(root, "yxu.yml");
  return {
    user: userConfigPath(env),
    project: !existsSync(join(root, "yxu.yaml")) && existsSync(yml) ? yml : join(root, "yxu.yaml"),
    local: join(root, "yxu.local.yaml"),
  };
}

/** Parse one config file's text: checks `version:` and returns the data without it. */
export function readLayerText(text: string, file: string): { data: Obj; version?: number } {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (e) {
    throw new Error(`invalid YAML in ${file}: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!isObj(raw)) throw new Error(`invalid config ${file}: the top level must be a mapping of settings`);
  const { version, ...data } = raw;
  if (version !== undefined) {
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new Error(`invalid config ${file}: version must be a whole number (current: ${CONFIG_VERSION})`);
    }
    if (version > CONFIG_VERSION) {
      throw new Error(`${file} uses config version ${version}, but this yxu understands up to ${CONFIG_VERSION}; run \`yxu update\``);
    }
  }
  return { data, version: version as number | undefined };
}

const ENV_SECTIONS = ["orchestrator", "settings", "context", "compact"];

/** YXU_ORCHESTRATOR_MAX_BUDGET_USD=2 → { orchestrator: { max_budget_usd: 2 } } */
export function envLayer(env: NodeJS.ProcessEnv): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.startsWith("YXU_")) continue;
    const rest = key.slice(4).toLowerCase();
    const section = ENV_SECTIONS.find((s) => rest.startsWith(`${s}_`));
    if (!section) continue;
    setPath(out, [section, rest.slice(section.length + 1)], parseScalar(value));
  }
  return out;
}

/** "a.b.c=value" (value parsed as YAML: numbers, booleans, [lists], null) → nested object. */
export function setsLayer(sets: string[]): Obj {
  const out: Obj = {};
  for (const s of sets) {
    const eq = s.indexOf("=");
    if (eq < 1) throw new Error(`--set expects key=value, got "${s}"`);
    setPath(out, splitKey(s.slice(0, eq)), parseScalar(s.slice(eq + 1)));
  }
  return out;
}

export function splitKey(key: string): string[] {
  const parts = key.trim().split(".");
  if (parts.some((p) => !p)) throw new Error(`bad config key "${key}"`);
  return parts;
}

function parseScalar(v: string): unknown {
  try {
    return parseYaml(v);
  } catch {
    return v;
  }
}

function setPath(obj: Obj, path: string[], value: unknown) {
  let o = obj;
  for (const k of path.slice(0, -1)) o = (isObj(o[k]) ? o[k] : (o[k] = {})) as Obj;
  o[path.at(-1)!] = value;
}

/** Merge `over` into `base` in place, recording which layer set each leaf. */
function merge(base: Obj, over: Obj, layer: LayerName, origins: Obj, prefix: string[] = []) {
  for (const [k, v] of Object.entries(over)) {
    const path = [...prefix, k];
    const key = path.join(".");
    const dropOrigins = () => {
      for (const o of Object.keys(origins)) if (o === key || o.startsWith(`${key}.`)) delete origins[o];
    };
    if (v === null) {
      delete base[k];
      dropOrigins();
      continue;
    }
    const cur = base[k];
    const cliChanged = prefix.length === 1 && prefix[0] === "agents" && isObj(cur) && isObj(v) && v.cli !== undefined && v.cli !== cur.cli;
    if (isObj(v) && isObj(cur) && !cliChanged) {
      merge(cur, v, layer, origins, path);
      continue;
    }
    dropOrigins();
    base[k] = structuredClone(v);
    markLeaves(base[k], key, layer, origins);
  }
}

function markLeaves(v: unknown, key: string, layer: LayerName, origins: Obj) {
  if (isObj(v) && Object.keys(v).length) {
    for (const [k, child] of Object.entries(v)) markLeaves(child, `${key}.${k}`, layer, origins);
  } else {
    origins[key] = layer;
  }
}

export interface LoadOptions {
  sets?: string[];
  env?: NodeJS.ProcessEnv;
  /** Use this text instead of a layer's file (to validate an edit before writing it). */
  override?: Partial<Record<FileLayer, string>>;
}

export interface Loaded {
  config: Config;
  layers: LayerInfo[];
  /** Merged raw values (before schema defaults), for `config explain`. */
  raw: Obj;
  /** Workflows that came from their own file: name → file. */
  workflowFiles: Record<string, string>;
}

/** `<dir>/<name>.yaml` files, each holding one workflow. */
export function readWorkflowDir(dir: string): Record<string, { file: string; data: Obj }> {
  const out: Record<string, { file: string; data: Obj }> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const m = /^([\w-]+)\.ya?ml$/.exec(entry);
    if (!m) continue;
    const file = join(dir, entry);
    if (out[m[1]!]) throw new Error(`workflow "${m[1]}" has two files in ${dir}`);
    out[m[1]!] = { file, data: readLayerText(readFileSync(file, "utf8"), file).data };
  }
  return out;
}

export function loadLayers(root: string, opts: LoadOptions = {}): Loaded {
  const env = opts.env ?? process.env;
  const paths = layerPaths(root, env);
  const layers: LayerInfo[] = [];
  for (const name of FILE_LAYERS) {
    const file = paths[name];
    const text = opts.override?.[name] ?? (existsSync(file) ? readFileSync(file, "utf8") : undefined);
    if (text === undefined) {
      layers.push({ name, file, exists: false, data: {} });
      continue;
    }
    const { data, version } = readLayerText(text, file);
    layers.push({ name, file, exists: true, version, data });
  }
  // Workflow files join their layer: ~/.config/yxu/workflows (user), .yxu/workflows (project).
  const workflowFiles: Record<string, string> = {};
  for (const [layerName, dir] of [["user", join(userConfigDir(env), "workflows")], ["project", join(root, ".yxu", "workflows")]] as const) {
    const found = readWorkflowDir(dir);
    if (!Object.keys(found).length) continue;
    const layer = layers.find((l) => l.name === layerName)!;
    const inline = isObj(layer.data.workflows) ? layer.data.workflows : {};
    for (const [wf, { file, data }] of Object.entries(found)) {
      if (wf in inline) throw new Error(`workflow "${wf}" is defined in both ${display(layer.file!, root)} and ${display(file, root)}`);
      inline[wf] = data;
      workflowFiles[wf] = display(file, root);
    }
    layer.data.workflows = inline;
  }
  // Until some file defines agents, the starter agents and workflows apply.
  const starter = !layers.some((l) => isObj(l.data.agents));
  const defaults: Obj = starter ? readLayerText(DEFAULT_YAML, "(built-in defaults)").data : {};
  layers.unshift({ name: "defaults", exists: true, data: defaults });
  layers.push({ name: "env", exists: true, data: envLayer(env) });
  layers.push({ name: "flags", exists: true, data: setsLayer(opts.sets ?? []) });

  const raw: Obj = {};
  const origins: Obj = {};
  for (const l of layers) merge(raw, l.data, l.name, origins);

  const files = layers.filter((l) => l.exists && l.file).map((l) => display(l.file!, root));
  const source = files.length ? files.join(" + ") : "(built-in defaults)";
  const fileOf = (layer: string) => {
    const l = layers.find((x) => x.name === layer);
    return l?.file ? display(l.file, root) : layer === "env" ? "environment (YXU_*)" : layer === "flags" ? "command-line flags" : "built-in defaults";
  };
  const where = (path: string) => {
    // The deepest recorded origin at or below this path.
    const hit = Object.keys(origins).find((o) => o === path || o.startsWith(`${path}.`)) ??
      path.split(".").map((_, i, a) => a.slice(0, a.length - i).join(".")).find((p) => origins[p]);
    return hit ? fileOf(origins[hit] as string) : source;
  };
  const config = validateConfig(raw, source, (path) => {
    const wf = /^workflows\.([^.]+)/.exec(path)?.[1];
    return wf && workflowFiles[wf] ? workflowFiles[wf] : where(path);
  });
  config.origins = origins as Record<string, string>;
  return { config, layers, raw, workflowFiles };
}

/** Paths under the repo are shown relative to it, the home directory as ~. */
export function display(file: string, root: string): string {
  const rel = relative(root, file);
  if (!rel.startsWith("..") && !rel.startsWith("/")) return rel;
  const home = homedir();
  return file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

/** The layer that decides a key's value, and the file behind it. */
export function originOf(loaded: Loaded, key: string, root: string): { layer: LayerName; file?: string } {
  const origins = loaded.config.origins ?? {};
  const parts = key.split(".");
  let layer: string | undefined;
  for (let i = parts.length; i > 0 && !layer; i--) layer = origins[parts.slice(0, i).join(".")];
  if (!layer) return { layer: "defaults" };
  const wf = /^workflows\.([^.]+)/.exec(key)?.[1];
  if (wf && loaded.workflowFiles[wf]) return { layer: layer as LayerName, file: loaded.workflowFiles[wf] };
  const l = loaded.layers.find((x) => x.name === layer);
  return { layer: layer as LayerName, file: l?.file ? display(l.file, root) : undefined };
}
