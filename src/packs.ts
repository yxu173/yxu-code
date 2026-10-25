/**
 * Packs: a folder with a `yxu-pack.yaml` manifest that bundles config, workflows, commands,
 * prompts and themes, so a setup can be shared with `yxu add <source>`.
 *
 *   yxu-pack.yaml         name, version, description, detect, yxu (min version), config
 *   workflows/<n>.yaml    become workflow <pack>:<n>
 *   commands/<n>.md       become /<pack>:<n>
 *   prompts/<name>.md     append to (or replace) a built-in prompt, like .yxu/prompts
 *   themes/<n>.yaml       themes, usable by name
 *   plugins/<n>.ts        plugins (code; project packs' plugins load once approved)
 *
 * Installed packs are copied into .yxu/packs/<name>/ (project, committed with the repo) or
 * ~/.config/yxu/packs/<name>/ (user), and pinned in yxu.lock next to them. A pack's config
 * is a layer just below the file it sits next to: user packs → user file → project packs →
 * project file, so your own files always win.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import { z } from "zod";
import { readLayerText, readWorkflowDir, userConfigDir } from "./config-layers.ts";
import { VERSION } from "./platform.ts";
import { compareVersions } from "./update.ts";

export const MANIFEST = "yxu-pack.yaml";
export const PACK_NAME = /^[a-z][a-z0-9-]*$/;

export const ManifestSchema = z
  .object({
    name: z.string().regex(PACK_NAME, "pack names are lowercase words, e.g. python or acme-review"),
    version: z.string().optional().describe("The pack's own version, e.g. 1.2.0"),
    description: z.string().optional(),
    yxu: z
      .string()
      .regex(/^>=\s*v?\d+(\.\d+){0,2}(-[\w.]+)?$/, 'yxu must be a minimum version such as ">=0.2.0"')
      .optional()
      .describe("Oldest yxu this pack works with"),
    detect: z.array(z.string()).optional().describe("Files that suggest this pack in `yxu init`, e.g. [pyproject.toml]"),
    homepage: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional().describe("yxu config this pack adds (agents, settings, workflows, hooks, ui, …)"),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;

export type PackScope = "user" | "project";

export interface LockedPack {
  source: string;
  /** Branch or tag asked for (git sources). */
  ref?: string;
  commit?: string;
  version?: string;
  integrity: string;
}
export interface LockedFile {
  commit?: string;
  integrity: string;
}
export interface Lock {
  packs: Record<string, LockedPack>;
  extends: Record<string, LockedFile>;
}

export function packsDir(scope: PackScope, root: string): string {
  return scope === "user" ? join(userConfigDir(), "packs") : join(root, ".yxu", "packs");
}

export function lockPath(scope: PackScope, root: string): string {
  return scope === "user" ? join(userConfigDir(), "yxu.lock") : join(root, "yxu.lock");
}

export function readLock(file: string): Lock {
  if (!existsSync(file)) return { packs: {}, extends: {} };
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    throw new Error(`invalid ${file}: ${(e as Error).message.split("\n")[0]}`);
  }
  const r = (raw ?? {}) as Partial<Lock>;
  return { packs: r.packs ?? {}, extends: r.extends ?? {} };
}

export function writeLock(file: string, lock: Lock) {
  const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const body: Record<string, unknown> = { version: 1 };
  if (Object.keys(lock.packs).length) body.packs = sorted(lock.packs);
  if (Object.keys(lock.extends).length) body.extends = sorted(lock.extends);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `# Written by yxu: packs and extends, pinned. Commit this file.\n${stringify(body)}`);
}

/** Read and check a pack's manifest. */
export function readManifest(dir: string): Manifest {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) throw new Error(`${dir} is not a yxu pack: it has no ${MANIFEST}`);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    throw new Error(`invalid YAML in ${file}: ${(e as Error).message.split("\n")[0]}`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ")}`);
  const m = parsed.data;
  if (m.yxu && compareVersions(VERSION, m.yxu.replace(/^>=\s*/, "")) < 0) {
    throw new Error(`pack ${m.name} needs yxu ${m.yxu}, this is ${VERSION}; run \`yxu update\``);
  }
  for (const k of ["extends", "version"]) if (m.config && k in m.config) throw new Error(`${file}: config.${k} is not allowed in a pack`);
  return m;
}

export interface InstalledPack {
  /** The namespace: the folder name (the manifest name, or the `--as` alias). */
  name: string;
  scope: PackScope;
  dir: string;
  manifest: Manifest;
}

/** Packs installed for a scope, in name order. */
export function installedPacks(scope: PackScope, root: string): InstalledPack[] {
  const base = packsDir(scope, root);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(base, e.name, MANIFEST)))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ name, scope, dir: join(base, name), manifest: readManifest(join(base, name)) }));
}

export function allPacks(root: string): InstalledPack[] {
  return [...installedPacks("user", root), ...installedPacks("project", root)];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A pack's contribution to the config: its `config`, with its workflows (inline and files)
 * renamed to <pack>:<name>, and calls between its own workflows renamed to match.
 */
export function packData(pack: InstalledPack): Obj {
  const data: Obj = structuredClone(pack.manifest.config ?? {});
  const own: Obj = isObj(data.workflows) ? data.workflows : {};
  for (const [name, { data: wf }] of Object.entries(readWorkflowDir(join(pack.dir, "workflows")))) {
    if (name in own) throw new Error(`pack ${pack.name}: workflow "${name}" is defined in both ${MANIFEST} and workflows/`);
    own[name] = wf;
  }
  if (!Object.keys(own).length) return data;
  const ns = (n: string) => `${pack.name}:${n}`;
  const rename = (steps: unknown) => {
    if (!Array.isArray(steps)) return;
    for (const st of steps) {
      if (!isObj(st)) continue;
      if (st.type === "workflow" && typeof st.workflow === "string" && st.workflow in own) st.workflow = ns(st.workflow);
      rename(st.steps);
    }
  };
  data.workflows = Object.fromEntries(
    Object.entries(own).map(([n, wf]) => {
      if (isObj(wf)) rename(wf.steps);
      return [ns(n), wf];
    }),
  );
  return data;
}

/** The workflow a pack's command means by `name`: its own <pack>:<name> if it has one. */
export function packWorkflowName(pack: { name: string }, name: string, workflows: Record<string, unknown>): string {
  return `${pack.name}:${name}` in workflows ? `${pack.name}:${name}` : name;
}

/** Folders of a kind ("commands", "prompts", "themes") from packs, in layer order, with their pack. */
export function packContentDirs(root: string, kind: "commands" | "prompts" | "themes", scope?: PackScope): { pack: InstalledPack; dir: string }[] {
  const packs = scope ? installedPacks(scope, root) : allPacks(root);
  return packs.map((pack) => ({ pack, dir: join(pack.dir, kind) })).filter((d) => existsSync(d.dir));
}

/** One line describing what a pack holds, for listings and the install summary. */
export function packContents(pack: InstalledPack): { workflows: string[]; commands: string[]; prompts: string[]; themes: string[]; plugins: string[]; config: string[]; runs: string[] } {
  const data = packData(pack);
  const names = (kind: string, ext: RegExp) => {
    const dir = join(pack.dir, kind);
    return existsSync(dir) ? readdirSync(dir).filter((f) => ext.test(f)).map((f) => f.replace(ext, "")).sort() : [];
  };
  const workflows = Object.keys(isObj(data.workflows) ? data.workflows : {});
  const commands = names("commands", /\.md$/).map((c) => `/${pack.name}:${c}`);
  const runs: string[] = [];
  const hooks = isObj(data.hooks) ? data.hooks : {};
  for (const [event, cmds] of Object.entries(hooks)) if (Array.isArray(cmds)) for (const c of cmds) runs.push(`${event} hook: ${c}`);
  const settings = isObj(data.settings) ? data.settings : {};
  if (typeof settings.verify === "string") runs.push(`verify: ${settings.verify}`);
  const walk = (wf: string, steps: unknown) => {
    if (!Array.isArray(steps)) return;
    for (const st of steps) {
      if (!isObj(st)) continue;
      if ((st.type === "shell" || st.type === "verify") && typeof st.command === "string") runs.push(`${wf} step ${st.id}: ${st.command}`);
      walk(wf, st.steps);
    }
  };
  for (const [n, wf] of Object.entries(isObj(data.workflows) ? data.workflows : {})) if (isObj(wf)) walk(n, wf.steps);
  for (const c of names("commands", /\.md$/)) {
    const text = readFileSync(join(pack.dir, "commands", `${c}.md`), "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    const meta = fm ? ((parseYaml(fm[1]!) ?? {}) as Obj) : {};
    const shell = meta.kind === "shell" || typeof meta.command === "string";
    if (shell) runs.push(`/${pack.name}:${c}: ${(typeof meta.command === "string" ? meta.command : (fm?.[2] ?? "")).trim().split("\n")[0]}`);
  }
  for (const [n, a] of Object.entries(isObj(data.agents) ? data.agents : {})) {
    if (isObj(a) && Array.isArray(a.command)) runs.push(`agent ${n}: ${a.command.join(" ")}`);
    if (isObj(a) && a.permission === "yolo") runs.push(`agent ${n} with yolo permission`);
  }
  const plugins = existsSync(join(pack.dir, "plugins"))
    ? readdirSync(join(pack.dir, "plugins")).filter((f) => /^[a-z][a-z0-9-]*(\.(ts|js|mjs))?$/.test(f)).map((f) => f.replace(/\.(ts|js|mjs)$/, "")).sort()
    : [];
  for (const p of plugins) runs.push(`plugin ${p}: code that runs inside yxu with your permissions`);
  const config = Object.keys(data).filter((k) => k !== "workflows");
  return { workflows, commands, prompts: names("prompts", /\.md$/), themes: names("themes", /\.ya?ml$/), plugins, config, runs };
}

/** Parse one config text the way the layers do (used for extends files). */
export function readConfigFile(text: string, file: string): Obj {
  return readLayerText(text, file).data;
}
