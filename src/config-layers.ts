/**
 * Configuration layers, merged in order (later wins; maps merge deeply, lists replace):
 *
 *   defaults   built-in schema defaults (+ the starter agents/workflows while no file defines agents)
 *   user-packs ~/.config/yxu/packs/<name>/      packs you installed with `yxu add --user`
 *   user       ~/.config/yxu/config.yaml        personal, every repo
 *   packs      <repo>/.yxu/packs/<name>/        packs installed in the repo with `yxu add`
 *   project    <repo>/yxu.yaml                  team, committed
 *   local      <repo>/yxu.local.yaml            personal for this repo, git-ignored
 *   env        YXU_ORCHESTRATOR_MODEL=sonnet …  (orchestrator/settings/context/compact keys)
 *   flags      --set key=value, --model, --budget
 *
 * A value of `null` removes what lower layers set (e.g. `agents: { heavy-coder: null }`).
 * An agent whose `cli` changes is replaced as a whole, so options for the old CLI don't leak.
 * A file may start from shared bases: `extends: [./base.yaml, github:acme/presets/python.yaml]`;
 * the file's own values win over its bases. Remote bases are pinned in yxu.lock.
 *
 * Origins record the layer that set each value; pack layers record "packs:<name>".
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONFIG_VERSION, DEFAULT_YAML, validateConfig, type Config } from "./config.ts";
import { installedPacks, lockPath, MANIFEST, packData, readLock, writeLock, type PackScope } from "./packs.ts";
import { cacheDir, fetchSource, integrity, parseSource } from "./sources.ts";
import { loadPlugins } from "./plugins.ts";
import { isTrusted } from "./trust.ts";

export const LAYERS = ["defaults", "user-packs", "user", "packs", "project", "local", "env", "flags"] as const;
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
  /** Pack layers: the pack's name (its origin is "<layer>:<pack>"). */
  pack?: string;
}

/** "packs:python" → "packs". */
export const baseLayer = (origin: string): LayerName => origin.split(":")[0] as LayerName;

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
function merge(base: Obj, over: Obj, layer: string, origins: Obj, prefix: string[] = []) {
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

function markLeaves(v: unknown, key: string, layer: string, origins: Obj) {
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
    const lock = lockPath(name === "user" ? "user" : "project", root);
    layers.push({ name, file, exists: true, version, data: withExtends(data, file, lock, env, [file]) });
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
  // Packs sit just below the file next to them: user packs → user, project packs → project.
  for (const [scope, layerName, before] of [["project", "packs", "project"], ["user", "user-packs", "user"]] as const) {
    const at = layers.findIndex((l) => l.name === before);
    const packs = installedPacks(scope as PackScope, root).map(
      (p): LayerInfo => ({ name: layerName, pack: p.name, file: join(p.dir, MANIFEST), exists: true, data: packData(p) }),
    );
    layers.splice(at, 0, ...packs);
  }
  layers.unshift({ name: "defaults", exists: true, data: defaults });
  layers.push({ name: "env", exists: true, data: envLayer(env) });
  layers.push({ name: "flags", exists: true, data: setsLayer(opts.sets ?? []) });

  const raw: Obj = {};
  const origins: Obj = {};
  for (const l of layers) merge(raw, l.data, l.pack ? `${l.name}:${l.pack}` : l.name, origins);

  const files = layers.filter((l) => l.exists && l.file && !l.pack).map((l) => display(l.file!, root));
  const packNames = layers.filter((l) => l.pack).map((l) => l.pack!);
  if (packNames.length) files.push(`packs: ${packNames.join(", ")}`);
  const source = files.length ? files.join(" + ") : "(built-in defaults)";
  const fileOf = (layer: string) => {
    const l = layers.find((x) => (x.pack ? `${x.name}:${x.pack}` : x.name) === layer);
    return l?.file ? display(l.file, root) : layer === "env" ? "environment (YXU_*)" : layer === "flags" ? "command-line flags" : "built-in defaults";
  };
  const where = (path: string) => {
    // The deepest recorded origin at or below this path.
    const hit = Object.keys(origins).find((o) => o === path || o.startsWith(`${path}.`)) ??
      path.split(".").map((_, i, a) => a.slice(0, a.length - i).join(".")).find((p) => origins[p]);
    return hit ? fileOf(origins[hit] as string) : source;
  };
  const registry = loadPlugins(root, env);
  const config = validateConfig(
    raw,
    source,
    (path) => {
      const wf = /^workflows\.([^.]+)/.exec(path)?.[1];
      return wf && workflowFiles[wf] ? workflowFiles[wf] : where(path);
    },
    { clis: [...registry.agents.keys()], orchestrators: [...registry.orchestrators.keys()] },
  );
  Object.defineProperty(config, "plugins", { value: registry, enumerable: false, writable: true });
  config.origins = origins as Record<string, string>;
  config.trusted = isTrusted(root, env);
  return { config, layers, raw, workflowFiles };
}

/** Paths under the repo are shown relative to it, the home directory as ~. */
export function display(file: string, root: string): string {
  const slash = (p: string) => p.split(sep).join("/");
  const rel = relative(root, file);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return slash(rel);
  const home = homedir();
  return file.startsWith(home + sep) ? `~/${slash(file.slice(home.length + 1))}` : file;
}

/** The layer that decides a key's value, and the file behind it. */
export function originOf(loaded: Loaded, key: string, root: string): { layer: LayerName; file?: string } {
  const origins = loaded.config.origins ?? {};
  const parts = key.split(".");
  let layer: string | undefined;
  for (let i = parts.length; i > 0 && !layer; i--) layer = origins[parts.slice(0, i).join(".")];
  if (!layer) return { layer: "defaults" };
  const wf = /^workflows\.([^.]+)/.exec(key)?.[1];
  if (wf && loaded.workflowFiles[wf]) return { layer: baseLayer(layer), file: loaded.workflowFiles[wf] };
  const l = loaded.layers.find((x) => (x.pack ? `${x.name}:${x.pack}` : x.name) === layer);
  const file = l?.file ? display(l.pack ? dirname(l.file) : l.file, root) : undefined;
  return { layer: baseLayer(layer), file: l?.pack ? `pack ${l.pack} (${file})` : file };
}

/**
 * Resolve a file's `extends:` list: each base (and its own bases) is merged first, then the
 * file's values on top. Local paths are relative to the file; remote files are fetched once,
 * cached in ~/.cache/yxu/extends and pinned (commit + hash) in the scope's yxu.lock.
 */
function withExtends(data: Obj, file: string, lock: string, env: NodeJS.ProcessEnv, stack: string[]): Obj {
  const ext = data.extends;
  delete data.extends;
  if (ext === undefined || ext === null) return data;
  const list = typeof ext === "string" ? [ext] : ext;
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) throw new Error(`invalid config ${file}: extends must be a file or a list of files`);
  if (stack.length > 6) throw new Error(`extends nests too deeply: ${stack.join(" → ")}`);
  const remoteParent = stack.length > 1 && !existsSync(file);
  const base: Obj = {};
  for (const spec of list as string[]) {
    const src = parseSource(spec, dirname(file));
    let text: string;
    let label: string;
    if (src.kind === "builtin") throw new Error(`${file}: extends "${spec}" names a starter pack; install it with \`yxu add ${src.name}\` instead`);
    if (src.kind === "local") {
      if (remoteParent) throw new Error(`${file}: a remote base can only extend other remote files, not "${spec}"`);
      if (!existsSync(src.path) || !statSync(src.path).isFile()) throw new Error(`${file}: extends "${spec}": ${src.path} is not a file`);
      text = readFileSync(src.path, "utf8");
      label = src.path;
    } else {
      text = remoteFile(spec, lock, env);
      label = spec;
    }
    if (stack.includes(label)) throw new Error(`extends loops: ${[...stack, label].join(" → ")}`);
    const resolved = withExtends(readLayerText(text, label).data, label, lock, env, [...stack, label]);
    merge(base, resolved, "extends", {});
  }
  merge(base, data, "extends", {});
  return base;
}

/** The text of a remote `extends:` file: from the cache when it matches yxu.lock, else fetched. */
function remoteFile(spec: string, lock: string, env: NodeJS.ProcessEnv): string {
  const src = parseSource(spec);
  if (src.kind !== "git") throw new Error(`not a remote file: ${spec}`);
  const locked = readLock(lock).extends[spec];
  const dir = join(cacheDir(env), "extends");
  const key = createHash("sha256").update(spec).digest("hex").slice(0, 16);
  if (locked?.commit) {
    const cached = join(dir, `${key}-${locked.commit}.yaml`);
    if (existsSync(cached) && integrity(cached) === locked.integrity) return readFileSync(cached, "utf8");
  }
  if (!src.subpath) throw new Error(`extends "${spec}" names a repository; add the file's path, e.g. github:owner/repo/base.yaml`);
  const got = fetchSource(src, { commit: locked?.commit });
  try {
    if (!statSync(got.path).isFile()) throw new Error(`extends "${spec}" is a folder, not a file`);
    const hash = integrity(got.path);
    if (locked && hash !== locked.integrity) {
      throw new Error(`extends "${spec}" changed since it was locked in ${lock} (commit ${locked.commit?.slice(0, 10)}); to accept the new content run \`yxu packs update --extends\``);
    }
    const text = readFileSync(got.path, "utf8");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}-${got.commit}.yaml`), text);
    if (!locked) {
      const l = readLock(lock);
      l.extends[spec] = { commit: got.commit, integrity: hash };
      writeLock(lock, l);
    }
    return text;
  } finally {
    got.cleanup();
  }
}

/** Forget the pinned commits of remote extends, so the next load fetches them fresh. */
export function unlockExtends(root: string): string[] {
  const out: string[] = [];
  for (const scope of ["project", "user"] as const) {
    const file = lockPath(scope, root);
    const l = readLock(file);
    if (!Object.keys(l.extends).length) continue;
    out.push(...Object.keys(l.extends));
    l.extends = {};
    writeLock(file, l);
  }
  return out;
}
