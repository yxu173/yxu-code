/**
 * `yxu add` and `yxu packs list|update|remove|install`: install packs into .yxu/packs (project)
 * or ~/.config/yxu/packs (--user), pin them in yxu.lock, and keep them in step with it.
 * Every change is checked by loading the whole config; if that fails, the change is undone.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { display, loadLayers, unlockExtends } from "./config-layers.ts";
import {
  installedPacks,
  lockPath,
  PACK_NAME,
  packContents,
  packsDir,
  readLock,
  readManifest,
  writeLock,
  type InstalledPack,
  type Lock,
  type LockedPack,
  type PackScope,
} from "./packs.ts";
import { VERSION } from "./platform.ts";
import { pluginsIn, setApproval } from "./plugins.ts";
import { copyInto, fetchSource, integrity, listFiles, parseSource, type Source } from "./sources.ts";

export interface PackIO {
  print: (line: string) => void;
  dim: (s: string) => string;
  /** Ask before installing; resolve false to cancel. Without it, the install goes ahead. */
  confirm?: (summary: string[], runs: string[]) => Promise<boolean>;
}

const SCOPES: PackScope[] = ["project", "user"];

/** What a pack holds and what it can run, as lines for the confirmation and `packs list -v`. */
export function describePack(pack: InstalledPack, from: string, into: string): { lines: string[]; runs: string[] } {
  const c = packContents(pack);
  const m = pack.manifest;
  const lines = [`pack ${pack.name}${m.version ? ` ${m.version}` : ""}${m.description ? ` — ${m.description}` : ""}`, `  from      ${from}`, `  into      ${into}`];
  if (c.workflows.length) lines.push(`  workflows ${c.workflows.join(" ")}`);
  if (c.commands.length) lines.push(`  commands  ${c.commands.join(" ")}`);
  if (c.prompts.length) lines.push(`  prompts   ${c.prompts.join(" ")} (appended to yxu's prompts)`);
  if (c.themes.length) lines.push(`  themes    ${c.themes.join(" ")}`);
  if (c.plugins.length) lines.push(`  plugins   ${c.plugins.join(" ")} (code)`);
  if (c.config.length) lines.push(`  config    ${c.config.join(", ")}`);
  return { lines, runs: c.runs };
}

/** How the lock records where a pack came from. Local paths are kept relative to the repo when inside it. */
function lockedSource(src: Source, root: string, scope: PackScope): string {
  if (src.kind !== "local") return src.spec;
  const rel = relative(root, src.path);
  return scope === "project" && !rel.startsWith("..") && !isAbsolute(rel) ? `./${rel}` : src.path;
}

/** Install `from` as pack `name`, check the config still loads, and roll back if it doesn't. */
function place(root: string, scope: PackScope, name: string, from: string, entry: Omit<LockedPack, "integrity">): LockedPack {
  const dest = join(packsDir(scope, root), name);
  const lockFile = lockPath(scope, root);
  const before: Lock = readLock(lockFile);
  const hadLock = existsSync(lockFile);
  const backup = existsSync(dest) ? mkdtempSync(join(tmpdir(), "yxu-pack-backup-")) : undefined;
  if (backup) cpSync(dest, join(backup, "pack"), { recursive: true });
  copyInto(from, dest);
  const locked: LockedPack = { ...entry, integrity: integrity(dest) };
  const after: Lock = structuredClone(before);
  after.packs[name] = locked;
  writeLock(lockFile, after);
  try {
    loadLayers(root);
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    if (backup) cpSync(join(backup, "pack"), dest, { recursive: true });
    if (hadLock) writeLock(lockFile, before);
    else rmSync(lockFile, { force: true });
    throw new Error(`pack ${name} doesn't fit your config, so nothing was changed:\n${(e as Error).message}`);
  } finally {
    if (backup) rmSync(backup, { recursive: true, force: true });
  }
  return locked;
}

export interface AddOptions {
  scope: PackScope;
  /** Install under another name (and namespace). */
  as?: string;
}

export async function addPack(root: string, spec: string, o: AddOptions, io: PackIO): Promise<InstalledPack | undefined> {
  const src = parseSource(spec);
  const got = fetchSource(src);
  try {
    const manifest = readManifest(got.path);
    const name = o.as ?? manifest.name;
    if (!PACK_NAME.test(name)) throw new Error(`"${name}" can't be a pack name: use lowercase words, e.g. --as my-pack`);
    const other = o.scope === "project" ? "user" : "project";
    if (existsSync(join(packsDir(o.scope, root), name))) {
      throw new Error(`pack ${name} is already installed${o.scope === "user" ? " for your user" : " in this repo"}: \`yxu packs update ${name}\` to update it, or --as <name> to install it again under another name`);
    }
    const into = `${display(join(packsDir(o.scope, root), name), root)} (${o.scope === "project" ? "this repo; pinned in yxu.lock" : "every repo; pinned in ~/.config/yxu/yxu.lock"})`;
    const from = `${src.spec}${got.commit ? ` @ ${got.commit.slice(0, 10)}` : src.kind === "builtin" ? ` (built into yxu ${VERSION})` : ""}`;
    const { lines, runs } = describePack({ name, scope: o.scope, dir: got.path, manifest }, from, into);
    if (io.confirm) {
      if (!(await io.confirm(lines, runs))) {
        io.print("cancelled; nothing was installed");
        return undefined;
      }
    } else {
      for (const l of lines) io.print(l);
      if (runs.length) io.print(`  can run   ${runs.join("\n            ")}`);
    }
    // You saw and confirmed the pack's plugins, so they're approved at this code.
    for (const p of pluginsIn(join(got.path, "plugins"))) {
      if (o.scope === "project") setApproval(join(packsDir(o.scope, root), name, "plugins", p.path.slice(join(got.path, "plugins").length + 1)), true, p.path);
    }
    place(root, o.scope, name, got.path, { source: lockedSource(src, root, o.scope), ref: src.kind === "git" ? src.ref : undefined, commit: got.commit, version: manifest.version });
    if (existsSync(join(packsDir(other, root), name))) io.print(io.dim(`note: a ${other} pack named ${name} is also installed; both apply, the project one last`));
    return installedPacks(o.scope, root).find((p) => p.name === name);
  } finally {
    got.cleanup();
  }
}

/** Which scope has pack `name` (project first unless `scope` says). */
function findScope(root: string, name: string, scope?: PackScope): PackScope {
  for (const s of scope ? [scope] : SCOPES) {
    if (existsSync(join(packsDir(s, root), name)) || readLock(lockPath(s, root)).packs[name]) return s;
  }
  throw new Error(`no pack named ${name}${scope ? ` (${scope})` : ""}; installed: ${[...SCOPES.flatMap((s) => installedPacks(s, root).map((p) => p.name))].join(", ") || "none"}`);
}

export function removePack(root: string, name: string, io: PackIO, scope?: PackScope) {
  const s = findScope(root, name, scope);
  rmSync(join(packsDir(s, root), name), { recursive: true, force: true });
  const lock = readLock(lockPath(s, root));
  delete lock.packs[name];
  writeLock(lockPath(s, root), lock);
  io.print(`✓ removed pack ${name} (${s})`);
  try {
    loadLayers(root);
  } catch (e) {
    io.print(`! your config referred to something from ${name}: ${(e as Error).message}`);
  }
}

/** Files added, removed and changed between two folders. */
function changes(oldDir: string, newDir: string): string[] {
  const a = existsSync(oldDir) ? listFiles(oldDir) : [];
  const b = listFiles(newDir);
  const out: string[] = [];
  for (const f of b) {
    if (!a.includes(f)) out.push(`+ ${f}`);
    else if (!readFileSync(join(oldDir, f)).equals(readFileSync(join(newDir, f)))) out.push(`~ ${f}`);
  }
  for (const f of a) if (!b.includes(f)) out.push(`- ${f}`);
  return out;
}

/** Fetch packs again from their source (branch/tag, or this yxu for starter packs) and re-pin them. */
export function updatePacks(root: string, names: string[], io: PackIO, opts: { scope?: PackScope; extends?: boolean } = {}): number {
  let changed = 0;
  const targets = names.length
    ? names.map((n) => ({ name: n, scope: findScope(root, n, opts.scope) }))
    : (opts.scope ? [opts.scope] : SCOPES).flatMap((s) => Object.keys(readLock(lockPath(s, root)).packs).map((n) => ({ name: n, scope: s })));
  for (const { name, scope } of targets) {
    const entry = readLock(lockPath(scope, root)).packs[name];
    if (!entry) throw new Error(`pack ${name} is not in ${display(lockPath(scope, root), root)}; reinstall it with \`yxu add\``);
    const src = parseSource(entry.source, root);
    const got = fetchSource(src);
    try {
      const manifest = readManifest(got.path);
      const dest = join(packsDir(scope, root), name);
      const diff = changes(dest, got.path);
      if (!diff.length && existsSync(dest)) {
        io.print(`✓ ${name} is up to date${entry.commit ? ` (${entry.commit.slice(0, 10)})` : ""}`);
        continue;
      }
      place(root, scope, name, got.path, { source: entry.source, ref: entry.ref, commit: got.commit, version: manifest.version });
      changed++;
      const ver = entry.version !== manifest.version ? ` ${entry.version ?? "?"} → ${manifest.version ?? "?"}` : "";
      const commit = got.commit && got.commit !== entry.commit ? ` (${entry.commit?.slice(0, 10) ?? "?"} → ${got.commit.slice(0, 10)})` : "";
      io.print(`✓ updated ${name}${ver}${commit}`);
      if (diff.some((d) => d.slice(2).startsWith("plugins/")) && scope === "project") io.print(`! its plugins changed: read them, then \`yxu plugins approve\``);
      for (const d of diff.slice(0, 20)) io.print(io.dim(`    ${d}`));
      if (diff.length > 20) io.print(io.dim(`    … ${diff.length - 20} more`));
    } finally {
      got.cleanup();
    }
  }
  if (opts.extends) {
    const specs = unlockExtends(root);
    loadLayers(root); // fetches and pins them again
    for (const s of specs) io.print(`✓ re-pinned extends ${s}`);
    changed += specs.length;
  }
  return changed;
}

export interface PackStatus {
  name: string;
  scope: PackScope;
  version?: string;
  source?: string;
  commit?: string;
  /** ok; modified: files differ from yxu.lock; missing: locked but not installed; unlocked: installed without a lock entry. */
  state: "ok" | "modified" | "missing" | "unlocked";
  pack?: InstalledPack;
}

export function packStatus(root: string): PackStatus[] {
  const out: PackStatus[] = [];
  for (const scope of SCOPES) {
    const lock = readLock(lockPath(scope, root));
    const installed = installedPacks(scope, root);
    for (const p of installed) {
      const e = lock.packs[p.name];
      const state = !e ? "unlocked" : integrity(p.dir) === e.integrity ? "ok" : "modified";
      out.push({ name: p.name, scope, version: p.manifest.version, source: e?.source, commit: e?.commit, state, pack: p });
    }
    for (const [name, e] of Object.entries(lock.packs)) {
      if (!installed.some((p) => p.name === name)) out.push({ name, scope, version: e.version, source: e.source, commit: e.commit, state: "missing" });
    }
  }
  return out;
}

/** Install every pack yxu.lock lists but the folder lacks, at the locked commit (`yxu packs install`). */
export function restorePacks(root: string, io: PackIO): number {
  let n = 0;
  for (const st of packStatus(root).filter((s) => s.state === "missing")) {
    const entry = readLock(lockPath(st.scope, root)).packs[st.name]!;
    const got = fetchSource(parseSource(entry.source, root), { commit: entry.commit });
    try {
      const hash = integrity(got.path);
      if (hash !== entry.integrity) {
        throw new Error(`pack ${st.name} from ${entry.source} doesn't match yxu.lock${entry.commit ? ` at ${entry.commit.slice(0, 10)}` : ""} (its content changed); \`yxu packs update ${st.name}\` accepts the new content`);
      }
      copyInto(got.path, join(packsDir(st.scope, root), st.name));
      io.print(`✓ installed ${st.name}${entry.commit ? ` @ ${entry.commit.slice(0, 10)}` : ""}`);
      n++;
    } finally {
      got.cleanup();
    }
  }
  loadLayers(root); // also fetches remote extends that aren't cached yet
  return n;
}
