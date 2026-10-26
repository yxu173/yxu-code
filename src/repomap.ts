/**
 * A map of the repository that every agent shares, so none of them rediscovers the layout on
 * every task: files and their symbols, what imports what, where the tests are, entry points,
 * and the project's conventions. Built from HEAD (what task worktrees start from), cached in
 * .yxu/repomap.json and updated incrementally: only files whose content changed are read again.
 *
 * `mapSlice(map, text)` picks what is relevant to a task (files and symbols it names, words it
 * shares with paths and symbols, their tests and neighbours) within a character budget. yxu puts
 * that slice before every subagent task, gives the orchestrator the overview, and answers its
 * `find_code` tool with it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, posix } from "node:path";
import { tryGit } from "./git.ts";

export interface MapSymbol {
  name: string;
  kind: string;
  line: number;
  exported?: boolean;
}

export interface MapFile {
  blob: string;
  size: number;
  lang?: string;
  symbols: MapSymbol[];
  /** Repo paths this file imports (relative imports that resolve to tracked files). */
  imports: string[];
  test: boolean;
  /** Indentation seen in the file: "tab", or the number of spaces. */
  indent?: string;
}

export interface Overview {
  languages: [string, number][];
  layout: { dir: string; files: number; langs: string[] }[];
  entryPoints: string[];
  commands: Record<string, string>;
  packageManager?: string;
  testing: { framework?: string; dirs: string[]; pattern?: string };
  conventions: string[];
}

export interface RepoMap {
  version: 1;
  head: string;
  builtAt: string;
  files: Record<string, MapFile>;
  overview: Overview;
}

const VERSION = 1;
const MAX_PARSE_BYTES = 256 * 1024;
const MAX_PARSED_FILES = 20_000;
const MAX_SYMBOLS = 60;

const LANGS: Record<string, string> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".py": "py", ".go": "go", ".rs": "rs", ".java": "java", ".kt": "kt", ".kts": "kt", ".cs": "cs", ".rb": "rb",
  ".php": "php", ".swift": "swift", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".md": "md", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".sh": "sh", ".sql": "sql",
  ".css": "css", ".scss": "css", ".html": "html", ".vue": "vue", ".svelte": "svelte",
};

/** Not worth reading: dependencies, build output, lock files, minified and generated code. */
const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|target|\.next|coverage|__pycache__)\/|(\.min\.(js|css)|\.lock|-lock\.(json|yaml)|\.lockb|\.map|\.snap|\.gen\.ts)$/;
const TEST = /(^|\/)(test|tests|__tests__|spec|specs)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;

const CODE = new Set(["ts", "js", "py", "go", "rs", "java", "kt", "cs", "rb", "php", "swift", "c", "cpp", "vue", "svelte"]);

// ── symbols ─────────────────────────────────────────────────────────────────

type Rule = [RegExp, string, (m: RegExpExecArray) => { name: string; exported?: boolean }];

const named = (i: number, exported?: (m: RegExpExecArray) => boolean) => (m: RegExpExecArray) => ({ name: m[i]!, exported: exported ? exported(m) : undefined });

const RULES: Record<string, Rule[]> = {
  ts: [
    [/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|class|interface|type|enum|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/, "", (m) => ({ name: m[2]!, exported: true })],
    [/^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, "function", named(1, () => false)],
    [/^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class", named(1, () => false)],
    [/^(?:interface|type)\s+([A-Za-z_$][\w$]*)/, "type", named(1, () => false)],
  ],
  py: [
    [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, "function", named(1, (m) => !m[1]!.startsWith("_"))],
    [/^class\s+([A-Za-z_]\w*)/, "class", named(1, (m) => !m[1]!.startsWith("_"))],
    [/^ {4}(?:async\s+)?def\s+([A-Za-z_]\w*)/, "method", named(1, (m) => !m[1]!.startsWith("_"))],
  ],
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "func", named(1, (m) => /^[A-Z]/.test(m[1]!))],
    [/^type\s+([A-Za-z_]\w*)\s+(struct|interface|func|\w)/, "type", named(1, (m) => /^[A-Z]/.test(m[1]!))],
  ],
  rs: [
    [/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(fn|struct|enum|trait|type|mod|const|static)\s+([A-Za-z_]\w*)/, "", (m) => ({ name: m[2]!, exported: true })],
    [/^(?:async\s+)?fn\s+([A-Za-z_]\w*)/, "fn", named(1, () => false)],
    [/^(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, "type", named(1, () => false)],
    [/^impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/, "impl", named(1)],
  ],
  java: [[/^\s*(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+|static\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)/, "", (m) => ({ name: m[2]!, exported: true })]],
  kt: [[/^\s*(?:data\s+|sealed\s+|abstract\s+|open\s+)*(class|interface|object|fun)\s+([A-Za-z_]\w*)/, "", (m) => ({ name: m[2]!, exported: true })]],
  cs: [[/^\s*(?:public\s+|internal\s+)?(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/, "", (m) => ({ name: m[2]!, exported: true })]],
  rb: [[/^\s*(def|class|module)\s+([\w.]+[?!]?)/, "", (m) => ({ name: m[2]!, exported: true })]],
  php: [[/^\s*(?:abstract\s+|final\s+)?(class|interface|trait|function)\s+([A-Za-z_]\w*)/, "", (m) => ({ name: m[2]!, exported: true })]],
  swift: [[/^\s*(?:public\s+|open\s+)?(class|struct|enum|protocol|func)\s+([A-Za-z_]\w*)/, "", (m) => ({ name: m[2]!, exported: true })]],
};
RULES.js = RULES.ts!;

export function symbolsOf(lang: string | undefined, text: string): MapSymbol[] {
  const rules = lang ? RULES[lang] : undefined;
  if (!rules) return [];
  const out: MapSymbol[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS; i++) {
    const line = lines[i]!;
    for (const [re, kind, pick] of rules) {
      const m = re.exec(line);
      if (!m) continue;
      const { name, exported } = pick(m);
      const k = kind || m[1]!.replace("*", "");
      if (!seen.has(name)) {
        seen.add(name);
        out.push({ name, kind: k, line: i + 1, ...(exported !== undefined ? { exported } : {}) });
      }
      break;
    }
  }
  return out;
}

/** Relative imports (JS/TS/Python), resolved against the tracked files. */
export function importsOf(path: string, lang: string | undefined, text: string, tracked: Set<string>): string[] {
  const out = new Set<string>();
  const dir = posix.dirname(path);
  if (lang === "ts" || lang === "js") {
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|^import\s+)["'](\.{1,2}\/[^"']+)["']/gm)) {
      const base = posix.normalize(posix.join(dir, m[1]!));
      const stem = base.replace(/\.(m|c)?js$/, "");
      const hit = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`, `${stem}.mjs`, `${base}/index.ts`, `${base}/index.js`].find((c) => tracked.has(c));
      if (hit) out.add(hit);
    }
  } else if (lang === "py") {
    for (const m of text.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import/gm)) {
      let base = dir;
      for (let i = 1; i < m[1]!.length; i++) base = posix.dirname(base);
      const rel = posix.join(base, m[2]!.replaceAll(".", "/"));
      const hit = [`${rel}.py`, `${rel}/__init__.py`].find((c) => tracked.has(c));
      if (hit) out.add(hit);
    }
  }
  return [...out];
}

function indentOf(text: string): string | undefined {
  let tabs = 0;
  const spaces = new Map<number, number>();
  for (const line of text.split("\n", 400)) {
    const m = /^([ \t]+)\S/.exec(line);
    if (!m) continue;
    if (m[1]!.startsWith("\t")) tabs++;
    else spaces.set(m[1]!.length, (spaces.get(m[1]!.length) ?? 0) + 1);
  }
  // Only even widths count (odd ones are continuation lines, comments, text in strings).
  const even = [...spaces.entries()].filter(([w]) => w % 2 === 0);
  const total = even.reduce((a, [, n]) => a + n, 0);
  if (tabs > total) return "tab";
  if (!total) return undefined;
  const twos = even.filter(([w]) => w % 4 === 2).reduce((a, [, n]) => a + n, 0);
  return twos / total > 0.1 ? "2" : "4";
}

// ── building ────────────────────────────────────────────────────────────────

export const mapPath = (root: string) => join(root, ".yxu", "repomap.json");

export function loadRepoMap(root: string): RepoMap | undefined {
  try {
    const m = JSON.parse(readFileSync(mapPath(root), "utf8")) as RepoMap;
    return m.version === VERSION ? m : undefined;
  } catch {
    return undefined;
  }
}

/** Blob contents by id (`git cat-file --batch`). */
function readBlobs(root: string, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const p = Bun.spawnSync(["git", "cat-file", "--batch"], { cwd: root, stdin: new TextEncoder().encode(`${ids.join("\n")}\n`), stdout: "pipe", stderr: "pipe" });
  const buf = Buffer.from(p.stdout);
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const [id, type, size] = buf.subarray(at, nl).toString().split(" ");
    if (type !== "blob") {
      at = nl + 1;
      continue;
    }
    const n = Number(size);
    out.set(id!, buf.subarray(nl + 1, nl + 1 + n).toString("utf8"));
    at = nl + 1 + n + 1;
  }
  return out;
}

/**
 * Build or update the map for HEAD. Unchanged files keep their entries; changed ones are read
 * again. Yields between batches so an interface stays responsive.
 */
export async function buildRepoMap(root: string, opts: { yieldEvery?: number } = {}): Promise<RepoMap | undefined> {
  const head = tryGit(root, "rev-parse", "HEAD");
  if (!head.ok) return undefined; // no commits yet
  const prev = loadRepoMap(root);
  if (prev?.head === head.out) return prev;
  const tree = tryGit(root, "ls-tree", "-r", "-l", "--full-tree", "HEAD").out;
  const entries: { path: string; blob: string; size: number }[] = [];
  for (const line of tree.split("\n")) {
    const m = /^\d+ blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/.exec(line);
    if (m) entries.push({ blob: m[1]!, size: Number(m[2]) || 0, path: unquote(m[3]!) });
  }
  const tracked = new Set(entries.map((e) => e.path));
  const files: Record<string, MapFile> = {};
  const toRead: typeof entries = [];
  for (const e of entries) {
    const old = prev?.files[e.path];
    if (old && old.blob === e.blob) files[e.path] = old;
    else toRead.push(e);
  }
  const every = opts.yieldEvery ?? 400;
  let parsed = Object.values(files).filter((f) => f.symbols.length || f.imports.length).length;
  for (let i = 0; i < toRead.length; i += every) {
    const batch = toRead.slice(i, i + every);
    const readable = batch.filter((e) => parsed < MAX_PARSED_FILES && e.size <= MAX_PARSE_BYTES && !SKIP.test(e.path) && CODE.has(LANGS[extname(e.path).toLowerCase()] ?? ""));
    const texts = readBlobs(root, readable.map((e) => e.blob));
    for (const e of batch) {
      const lang = LANGS[extname(e.path).toLowerCase()];
      const text = texts.get(e.blob);
      if (text !== undefined) parsed++;
      files[e.path] = {
        blob: e.blob,
        size: e.size,
        ...(lang ? { lang } : {}),
        symbols: text ? symbolsOf(lang, text) : [],
        imports: text ? importsOf(e.path, lang, text, tracked) : [],
        test: TEST.test(e.path),
        ...(text ? { indent: indentOf(text) } : {}),
      };
    }
    if (opts.yieldEvery !== 0) await new Promise((r) => setImmediate(r));
  }
  const map: RepoMap = { version: VERSION, head: head.out, builtAt: new Date().toISOString(), files, overview: overview(root, files) };
  try {
    mkdirSync(dirname(mapPath(root)), { recursive: true });
    const tmp = `${mapPath(root)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(map));
    renameSync(tmp, mapPath(root));
  } catch {
    // read-only checkout: the map still serves this process
  }
  return map;
}

/** `git ls-tree` quotes unusual paths: "a\tb.txt" → a<tab>b.txt. */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p) as string;
  } catch {
    return p.slice(1, -1);
  }
}

// ── overview ────────────────────────────────────────────────────────────────

function readJson(root: string, file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch {
    return undefined;
  }
}

function overview(root: string, files: Record<string, MapFile>): Overview {
  const paths = Object.keys(files);
  const has = (p: string) => p in files;
  const count = new Map<string, number>();
  const dirs = new Map<string, { files: number; langs: Map<string, number> }>();
  for (const [p, f] of Object.entries(files)) {
    if (SKIP.test(p)) continue;
    if (f.lang && CODE.has(f.lang)) count.set(f.lang, (count.get(f.lang) ?? 0) + 1);
    const top = p.includes("/") ? `${p.split("/")[0]}/` : "(root)";
    const d = dirs.get(top) ?? { files: 0, langs: new Map() };
    d.files++;
    if (f.lang) d.langs.set(f.lang, (d.langs.get(f.lang) ?? 0) + 1);
    dirs.set(top, d);
  }
  const layout = [...dirs.entries()]
    .sort((a, b) => b[1].files - a[1].files)
    .slice(0, 14)
    .map(([dir, d]) => ({ dir, files: d.files, langs: [...d.langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l) }));

  const entryPoints: string[] = [];
  const commands: Record<string, string> = {};
  const conventions: string[] = [];
  let packageManager: string | undefined;
  const testing: Overview["testing"] = { dirs: [] };

  const pkg = has("package.json") ? readJson(root, "package.json") : undefined;
  if (pkg) {
    packageManager = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const run = packageManager === "npm" ? "npm run" : `${packageManager} run`;
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    for (const k of ["test", "build", "lint", "typecheck", "format", "dev", "start"]) if (scripts[k]) commands[k] = k === "test" && packageManager !== "bun" ? `${packageManager} test` : `${run} ${k}`;
    for (const k of ["main", "module"]) if (typeof pkg[k] === "string") entryPoints.push(String(pkg[k]).replace(/^\.\//, ""));
    if (typeof pkg.bin === "string") entryPoints.push(pkg.bin.replace(/^\.\//, ""));
    else if (pkg.bin && typeof pkg.bin === "object") entryPoints.push(...Object.values(pkg.bin as Record<string, string>).map((v) => v.replace(/^\.\//, "")));
    conventions.push(pkg.type === "module" ? "ES modules" : "CommonJS modules (no \"type\": \"module\")");
    const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
    testing.framework = deps.vitest ? "vitest" : deps.jest ? "jest" : deps.mocha ? "mocha" : /bun test/.test(scripts.test ?? "") || packageManager === "bun" ? "bun test" : /node --test/.test(scripts.test ?? "") ? "node:test" : undefined;
    if (has("tsconfig.json")) {
      const ts = readJson(root, "tsconfig.json");
      conventions.push(`TypeScript${(ts?.compilerOptions as { strict?: boolean } | undefined)?.strict ? " (strict)" : ""}`);
    }
  }
  if (has("go.mod")) {
    commands.test ??= "go test ./...";
    testing.framework ??= "go test (table-driven, *_test.go next to the code)";
  }
  if (has("Cargo.toml")) {
    commands.test ??= "cargo test";
    commands.lint ??= "cargo clippy";
    testing.framework ??= "cargo test";
  }
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    const py = has("pyproject.toml") ? readFileSync(join(root, "pyproject.toml"), "utf8") : "";
    packageManager ??= has("uv.lock") ? "uv" : has("poetry.lock") ? "poetry" : "pip";
    if (/pytest/.test(py) || has("pytest.ini") || paths.some((p) => /(^|\/)test_[^/]+\.py$|_test\.py$/.test(p))) {
      testing.framework ??= "pytest";
      commands.test ??= packageManager === "uv" ? "uv run pytest" : packageManager === "poetry" ? "poetry run pytest" : "python -m pytest";
    }
    if (/\[tool\.ruff/.test(py)) conventions.push("ruff");
    if (/\[tool\.mypy/.test(py)) conventions.push("mypy");
  }
  if (has("Makefile")) {
    const mk = readFileSync(join(root, "Makefile"), "utf8");
    for (const k of ["test", "build", "lint"]) if (new RegExp(`^${k}:`, "m").test(mk)) commands[k] ??= `make ${k}`;
  }
  for (const p of ["src/index.ts", "src/main.ts", "src/cli.ts", "src/index.js", "index.js", "main.go", "src/main.rs", "src/lib.rs", "manage.py", "app.py", "main.py"]) if (has(p)) entryPoints.push(p);
  for (const p of paths) {
    if (/^cmd\/[^/]+\/main\.go$/.test(p) || /(^|\/)__main__\.py$/.test(p)) entryPoints.push(p);
  }
  const testFiles = paths.filter((p) => files[p]!.test);
  testing.dirs = [...new Set(testFiles.map((p) => (p.includes("/") ? `${dirname(p)}/` : "(root)")))].slice(0, 6);
  const pat = testFiles.some((p) => /\.test\.[a-z]+$/.test(p)) ? "*.test.*" : testFiles.some((p) => /\.spec\.[a-z]+$/.test(p)) ? "*.spec.*" : testFiles.some((p) => /_test\.go$/.test(p)) ? "*_test.go" : testFiles.some((p) => /test_[^/]+\.py$/.test(p)) ? "test_*.py" : undefined;
  if (pat) testing.pattern = pat;
  for (const [f, what] of [
    [".prettierrc", "prettier"], [".prettierrc.json", "prettier"], ["biome.json", "biome"], ["eslint.config.js", "eslint"], [".eslintrc.json", "eslint"],
    ["rustfmt.toml", "rustfmt"], [".editorconfig", ".editorconfig"], [".golangci.yml", "golangci-lint"],
  ] as const) if (has(f) && !conventions.includes(what)) conventions.push(what);
  const indents = new Map<string, number>();
  for (const f of Object.values(files)) if (f.indent && f.lang && CODE.has(f.lang)) indents.set(f.indent, (indents.get(f.indent) ?? 0) + 1);
  const ind = [...indents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (ind) conventions.push(ind === "tab" ? "indent with tabs" : `${ind}-space indent`);
  return {
    languages: [...count.entries()].sort((a, b) => b[1] - a[1]),
    layout,
    entryPoints: [...new Set(entryPoints)].filter((p) => has(p)).slice(0, 8),
    commands,
    ...(packageManager ? { packageManager } : {}),
    testing,
    conventions,
  };
}

// ── slices ──────────────────────────────────────────────────────────────────

const STOP = new Set("the and for with that this from into when then than not are was were have has had will would should could can its it's add make use using change update fix file files code test tests new all any each also only just like more some such them they their there these those what which while your you our out get set put via per one two".split(" "));

/** Words of a text, with camelCase and snake_case split: "getUserName" → get, user, name. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

export function overviewText(map: RepoMap): string {
  const o = map.overview;
  const lines: string[] = [];
  if (o.layout.length) lines.push(`Layout: ${o.layout.map((d) => `${d.dir} (${d.files}${d.langs.length ? ` ${d.langs.join("/")}` : ""})`).join(", ")}`);
  if (o.entryPoints.length) lines.push(`Entry points: ${o.entryPoints.join(", ")}`);
  const cmds = Object.entries(o.commands).map(([k, v]) => `${k}: \`${v}\``);
  if (cmds.length || o.packageManager) lines.push(`Commands: ${[...cmds, ...(o.packageManager ? [`package manager ${o.packageManager}`] : [])].join(" · ")}`);
  const t = o.testing;
  if (t.framework || t.dirs.length) lines.push(`Tests: ${[t.framework, t.dirs.length ? `in ${t.dirs.join(", ")}` : "", t.pattern ? `named ${t.pattern}` : ""].filter(Boolean).join(", ")}`);
  if (o.conventions.length) lines.push(`Conventions: ${o.conventions.join(", ")}`);
  return lines.join("\n");
}

/** Tests that belong to a source file (foo.ts → foo.test.ts, test/foo.test.ts, foo_test.go, test_foo.py). */
function testsFor(map: RepoMap, path: string): string[] {
  const stem = basename(path).replace(/\.[^.]+$/, "");
  return Object.keys(map.files)
    .filter((p) => map.files[p]!.test && p !== path)
    .filter((p) => {
      const b = basename(p).replace(/\.[^.]+$/, "");
      return b === `${stem}.test` || b === `${stem}.spec` || b === `${stem}_test` || b === `test_${stem}`;
    })
    .slice(0, 3);
}

export interface SliceOptions {
  /** Characters to spend (overview included). */
  chars?: number;
  /** Leave the overview out (when it is shown elsewhere). */
  noOverview?: boolean;
}

/** Files ranked by relevance to a text: named paths and symbols first, then shared words. */
export function rankFiles(map: RepoMap, text: string): { path: string; score: number }[] {
  const ws = new Set(words(text));
  const idents = new Set([...text.matchAll(/[A-Za-z_$][\w$]{2,}/g)].map((m) => m[0]));
  const scores = new Map<string, number>();
  for (const [path, f] of Object.entries(map.files)) {
    if (SKIP.test(path)) continue;
    let score = 0;
    if (text.includes(path)) score += 30;
    else if (path.includes("/") && text.includes(basename(path)) && basename(path).includes(".")) score += 12;
    const pw = words(path);
    for (const w of pw) if (ws.has(w)) score += 3;
    for (const s of f.symbols) {
      if (idents.has(s.name)) score += s.exported === false ? 6 : 8;
      else for (const w of words(s.name)) if (ws.has(w)) score += 0.5;
    }
    if (f.test) score *= 0.6; // the source first; its tests come with it
    if (score > 0) scores.set(path, score);
  }
  // Neighbours: files a hit imports, and files importing a hit.
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [path, s] of top) {
    for (const imp of map.files[path]!.imports) scores.set(imp, (scores.get(imp) ?? 0) + s * 0.25);
    for (const [other, f] of Object.entries(map.files)) if (f.imports.includes(path)) scores.set(other, (scores.get(other) ?? 0) + s * 0.15);
  }
  return [...scores.entries()].map(([path, score]) => ({ path, score })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/** The part of the map relevant to a task, as text for an agent. */
export function mapSlice(map: RepoMap, text: string, opts: SliceOptions = {}): string {
  const budget = opts.chars ?? 4000;
  const head = "## Repo map (from yxu; paths are relative to the repository root, which is your current directory)";
  const parts = [head];
  let used = head.length;
  if (!opts.noOverview) {
    // Overview lines while they fit, most useful first (layout, entry points, commands, tests…).
    for (const line of overviewText(map).split("\n").filter(Boolean)) {
      if (used + line.length + 1 > budget) break;
      parts.push(line);
      used += line.length + 1;
    }
  }
  const ws = new Set(words(text));
  const idents = new Set([...text.matchAll(/[A-Za-z_$][\w$]{2,}/g)].map((m) => m[0]));
  const ranked = rankFiles(map, text).filter((r) => r.score >= 2);
  const shown = new Set<string>();
  const lines: string[] = [];
  for (const { path } of ranked) {
    if (shown.has(path)) continue;
    const f = map.files[path]!;
    // The symbols the task names (or shares words with) first, then what the file exports.
    const exported = f.symbols.filter((s) => s.exported !== false);
    const pool = exported.length ? exported : f.symbols;
    const rel = (sym: MapSymbol) => (idents.has(sym.name) ? 2 : words(sym.name).some((w) => ws.has(w)) ? 1 : 0);
    const syms = [...f.symbols.filter((sym) => rel(sym) === 2), ...pool.filter((sym) => rel(sym) === 1), ...pool]
      .filter((sym, i, all) => all.indexOf(sym) === i)
      .slice(0, 12)
      .map((sym) => `${sym.name}:${sym.line}`);
    const tests = testsFor(map, path).filter((t) => !shown.has(t));
    const line = `- ${path}${syms.length ? ` — ${syms.join(", ")}` : ""}${tests.length ? ` (tests: ${tests.join(", ")})` : ""}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
    shown.add(path);
    for (const t of tests) shown.add(t);
    if (lines.length >= 25) break;
  }
  if (lines.length) parts.push(`Likely relevant (by the names in the task):\n${lines.join("\n")}`);
  return parts.join("\n");
}

/** Up to date for HEAD, or at least the last one built (stale is better than nothing). */
export function currentMap(root: string): RepoMap | undefined {
  return loadRepoMap(root);
}

export function mapExists(root: string): boolean {
  return existsSync(mapPath(root));
}
