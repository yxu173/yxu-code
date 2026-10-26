import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMap, parseDocument, type Document } from "yaml";
import { CONFIG_VERSION, DEFAULT_YAML, SCHEMA_COMMENT, type Config } from "./config.ts";
import { layerPaths, loadLayers, type FileLayer } from "./config-layers.ts";
import { git } from "./git.ts";

export type ConfigPatch = { path: string[]; value: unknown }[];

const newLayerText = (layer: FileLayer) =>
  layer === "local"
    ? `${SCHEMA_COMMENT}\n# Personal settings for this repo (git-ignored). They override yxu.yaml.\nversion: ${CONFIG_VERSION}\n`
    : `${SCHEMA_COMMENT}\nversion: ${CONFIG_VERSION}\n`;

/**
 * Apply changes to one layer's file, keeping comments and layout, and create it if needed.
 * A new project file starts from the starter config while no layer defines agents.
 * The merged result of all layers is validated before anything is written.
 * Returns the file written.
 */
export function saveConfigPatch(root: string, patch: ConfigPatch, layer: FileLayer = "project"): string {
  const file = layerPaths(root)[layer];
  let text: string;
  if (existsSync(file)) text = readFileSync(file, "utf8");
  else if (layer === "project" && !loadLayers(root).layers.some((l) => l.name !== "defaults" && !l.pack && l.data.agents)) text = DEFAULT_YAML;
  else text = newLayerText(layer);
  const doc = parseDocument(text);
  for (const { path, value } of patch) {
    if (value === undefined || value === null) doc.deleteIn(path);
    // Objects (a new agent) become YAML nodes, so later changes can set values inside them.
    else doc.setIn(path, typeof value === "object" ? doc.createNode(value) : value);
  }
  // null means "gone": deleting it from this file is enough unless a lower layer still sets it.
  const removals = patch.filter((p) => p.value === null);
  if (removals.length) {
    const merged = loadLayers(root, { override: { [layer]: doc.toString() } }).raw;
    for (const { path } of removals) if (getIn(merged, path) !== undefined) doc.setIn(path, null);
  }
  const out = doc.toString();
  loadLayers(root, { override: { [layer]: out } }); // throws with a readable message if invalid
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, out);
  if (layer === "local") excludeFromGit(root, "yxu.local.yaml");
  return file;
}

const getIn = (obj: unknown, path: string[]): unknown =>
  path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

/** Keep a personal file out of commits without touching the team's .gitignore. */
export function excludeFromGit(root: string, pattern: string) {
  try {
    const exclude = join(resolve(root, git(root, "rev-parse", "--git-common-dir")), "info", "exclude");
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (current.split("\n").includes(pattern)) return;
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
  } catch {
    // not a git repo: nothing to ignore
  }
}

/** The context/compact settings as a patch (what `/context save` persists). */
export function contextPatch(cfg: Config): ConfigPatch {
  const c = cfg.context;
  const k = cfg.compact;
  return [
    { path: ["context", "memory"], value: c.memory },
    { path: ["context", "project_instructions"], value: c.project_instructions },
    { path: ["context", "include"], value: c.include },
    { path: ["context", "notes"], value: c.notes?.trim() ? c.notes : undefined },
    { path: ["compact", "auto"], value: k.auto },
    { path: ["compact", "window"], value: k.window },
    { path: ["compact", "instructions"], value: k.instructions?.trim() ? k.instructions : undefined },
    { path: ["compact", "warn_at"], value: k.warn_at },
  ];
}

// ── migrations ─────────────────────────────────────────────────────────────

/**
 * MIGRATIONS[n] upgrades a document from version n to n+1, editing it in place
 * (comments survive). Version 0 means "no version: key" (files written before versioning).
 */
const MIGRATIONS: Record<number, (doc: Document) => void> = {
  0: (doc) => {
    if (!isMap(doc.contents)) return;
    const items = doc.contents.items;
    // The file's header comment belongs above `version:`, not to the first setting.
    const first = items[0]?.key as { commentBefore?: string | null } | undefined;
    if (first?.commentBefore && !doc.commentBefore) {
      doc.commentBefore = first.commentBefore;
      first.commentBefore = undefined;
    }
    items.unshift(doc.createPair("version", 1) as (typeof items)[number]);
  },
};

export interface Migration {
  from: number;
  to: number;
  before: string;
  after: string;
}

/** Upgrade config text to the current version (no-op when it already is). */
export function migrateText(text: string): Migration {
  const doc = parseDocument(text);
  const v = doc.get("version");
  const from = typeof v === "number" ? v : 0;
  if (from > CONFIG_VERSION) throw new Error(`config version ${from} is newer than this yxu (${CONFIG_VERSION}); run \`yxu update\``);
  for (let n = from; n < CONFIG_VERSION; n++) {
    const step = MIGRATIONS[n];
    if (!step) throw new Error(`no migration from config version ${n}`);
    step(doc);
    if (n > 0) doc.set("version", n + 1);
  }
  return { from, to: CONFIG_VERSION, before: text, after: from === CONFIG_VERSION ? text : doc.toString() };
}
