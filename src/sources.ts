/**
 * Where packs and `extends:` files come from, and how they are fetched and pinned.
 *
 *   python                              a starter pack built into yxu (also builtin:python)
 *   github:acme/yxu-python              a GitHub repo (gitlab:, codeberg: work the same way)
 *   github:acme/presets/python.yaml@v2  a path inside a repo, at a tag, branch or commit
 *   https://host/x.git#main             any git URL; `//sub/path` selects a folder or file
 *   ./my-pack  ~/packs/x  /abs/path     a local folder or file
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { BUILTIN_PACKS } from "./builtin-packs.gen.ts";
import { git } from "./git.ts";

export type Source =
  | { kind: "builtin"; name: string; spec: string }
  | { kind: "local"; path: string; spec: string }
  | { kind: "git"; url: string; subpath?: string; ref?: string; spec: string };

const HOSTS: Record<string, string> = { github: "github.com", gitlab: "gitlab.com", codeberg: "codeberg.org" };

export function builtinPackNames(): string[] {
  return Object.keys(BUILTIN_PACKS).sort();
}

/** Parse a source spec. Local paths resolve against `base` (the folder of the file that names them). */
export function parseSource(spec: string, base = process.cwd()): Source {
  const s = spec.trim();
  if (!s) throw new Error("empty source");
  if (s.startsWith("builtin:") || /^[a-z][a-z0-9-]*$/.test(s)) {
    const name = s.replace(/^builtin:/, "");
    if (!BUILTIN_PACKS[name]) {
      throw new Error(`"${s}" is not a starter pack (starter packs: ${builtinPackNames().join(", ")}); for a repo use github:owner/repo, for a folder ./path`);
    }
    return { kind: "builtin", name, spec: `builtin:${name}` };
  }
  if (s.startsWith(".") || s.startsWith("/") || s.startsWith("~")) {
    const path = s.startsWith("~") ? join(homedir(), s.slice(1)) : resolve(base, s);
    return { kind: "local", path, spec: s };
  }
  const short = /^(github|gitlab|codeberg):([\w.-]+)\/([\w.-]+)((?:\/[^@#]+)?)(?:[@#](.+))?$/.exec(s);
  if (short) {
    const [, host, owner, repo, sub, ref] = short;
    return { kind: "git", url: `https://${HOSTS[host!]}/${owner}/${repo!.replace(/\.git$/, "")}.git`, subpath: sub ? sub.slice(1) : undefined, ref, spec: s };
  }
  if (/^(git\+)?(https?|ssh|file|git):\/\//.test(s) || /^[\w.-]+@[\w.-]+:/.test(s)) {
    let rest = s.replace(/^git\+/, "");
    let ref: string | undefined;
    const hash = rest.indexOf("#");
    if (hash >= 0) [rest, ref] = [rest.slice(0, hash), rest.slice(hash + 1)];
    // `//` after the scheme's own `//` separates the repo from a path inside it.
    const schemeEnd = rest.indexOf("://");
    const sep = rest.indexOf("//", schemeEnd >= 0 ? schemeEnd + 3 : 0);
    const url = sep >= 0 ? rest.slice(0, sep) : rest;
    const subpath = sep >= 0 ? rest.slice(sep + 2).replace(/\/$/, "") : undefined;
    return { kind: "git", url, subpath: subpath || undefined, ref: ref || undefined, spec: s };
  }
  throw new Error(`can't tell where "${s}" comes from: use a starter pack name, github:owner/repo, a git URL, or ./path`);
}

export interface Fetched {
  /** The fetched folder or file (inside a temp dir for git and builtin sources). */
  path: string;
  /** The exact commit (git sources). */
  commit?: string;
  cleanup: () => void;
}

/** Fetch a source into a temp dir. `commit` pins git sources to a locked commit. */
export function fetchSource(src: Source, opts: { commit?: string } = {}): Fetched {
  if (src.kind === "local") {
    if (!existsSync(src.path)) throw new Error(`${src.spec}: ${src.path} does not exist`);
    return { path: src.path, cleanup: () => {} };
  }
  const tmp = mkdtempSync(join(tmpdir(), "yxu-fetch-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    if (src.kind === "builtin") {
      for (const [rel, text] of Object.entries(BUILTIN_PACKS[src.name]!)) writeFileDeep(join(tmp, rel), text);
      return { path: tmp, cleanup };
    }
    const repo = join(tmp, "repo");
    git(tmp, "init", "-q", repo);
    git(repo, "remote", "add", "origin", src.url);
    const want = opts.commit ?? src.ref ?? "HEAD";
    try {
      git(repo, "fetch", "-q", "--depth", "1", "origin", want);
    } catch (e) {
      throw new Error(`could not fetch ${src.url}${want === "HEAD" ? "" : ` at ${want}`}: ${(e as Error).message.replace(/^git [^:]*failed: /, "")}`);
    }
    git(repo, "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD");
    const commit = git(repo, "rev-parse", "HEAD");
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    const path = src.subpath ? join(repo, src.subpath) : repo;
    if (relative(repo, path).startsWith("..")) throw new Error(`${src.spec}: the path leaves the repository`);
    if (!existsSync(path)) throw new Error(`${src.spec}: ${src.subpath} not found in ${src.url}`);
    return { path, commit, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

function writeFileDeep(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Every file under a folder (or the file itself), as sorted relative paths. Skips .git. */
export function listFiles(path: string): string[] {
  if (statSync(path).isFile()) return [""];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(path, p));
    }
  };
  walk(path);
  return out.sort();
}

/** A content hash over file names and contents: "sha256-<hex>". */
export function integrity(path: string): string {
  const h = createHash("sha256");
  for (const rel of listFiles(path)) {
    h.update(`${rel}\0`);
    h.update(readFileSync(rel ? join(path, rel) : path));
    h.update("\0");
  }
  return `sha256-${h.digest("hex")}`;
}

/** Copy a fetched folder to its install location, replacing what was there. */
export function copyInto(from: string, to: string) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes(".git") });
}

/** Where fetched `extends:` files are cached: ~/.cache/yxu/extends. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "yxu");
}
