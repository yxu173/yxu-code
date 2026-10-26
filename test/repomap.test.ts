import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { buildContextPrompt } from "../src/context.ts";
import { git, YXU_IDENTITY } from "../src/git.ts";
import { Session, TaskOps } from "../src/ops.ts";
import { buildRepoMap, importsOf, loadRepoMap, mapSlice, overviewText, rankFiles, symbolsOf, words } from "../src/repomap.ts";
import { fakeCli, pathWith } from "./helpers.ts";

let root: string;
let bin: string;
const origPath = process.env.PATH;

const write = (files: Record<string, string>) => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  git(root, "add", "-A");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "x");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-map-"));
  bin = mkdtempSync(join(tmpdir(), "yxu-map-bin-"));
  git(root, "init", "-q", "-b", "main");
  process.env.PATH = pathWith(bin, origPath);
});
afterEach(() => {
  process.env.PATH = origPath;
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

const PROJECT = {
  "package.json": JSON.stringify({ type: "module", main: "src/index.ts", scripts: { test: "vitest run", build: "tsc" }, devDependencies: { vitest: "1" } }),
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "src/index.ts": 'import { createSession } from "./auth/session.js";\nexport function main() {\n  return createSession("x");\n}\n',
  "src/auth/session.ts": 'import { hashToken } from "../util/crypto";\nexport interface Session {\n  id: string;\n}\nexport function createSession(user: string): Session {\n  return { id: hashToken(user) };\n}\nexport const SESSION_TTL = 3600;\nfunction internalHelper() {}\n',
  "src/util/crypto.ts": "export function hashToken(t: string) {\n  return t;\n}\n",
  "src/billing/invoice.ts": "export class InvoiceBuilder {\n  build() {\n    return 1;\n  }\n}\n",
  "src/auth/session.test.ts": 'import { createSession } from "./session";\ntest("x", () => {\n  expect(createSession("a")).toBeTruthy();\n});\n',
  "README.md": "# app\n",
  "node_modules/dep/index.js": "export function shouldNotAppear() {}\n",
};

describe("symbols and imports", () => {
  test("per language", () => {
    expect(symbolsOf("ts", PROJECT["src/auth/session.ts"]).map((s) => [s.name, s.kind, s.exported])).toEqual([
      ["Session", "interface", true],
      ["createSession", "function", true],
      ["SESSION_TTL", "const", true],
      ["internalHelper", "function", false],
    ]);
    expect(symbolsOf("py", "class Repo:\n    def save(self):\n        pass\n\ndef _private():\n    pass\nasync def fetch_all():\n    pass\n").map((s) => `${s.kind} ${s.name} ${s.exported}`)).toEqual([
      "class Repo true",
      "method save true",
      "function _private false",
      "function fetch_all true",
    ]);
    expect(symbolsOf("go", "func (s *Server) Start() error {\n}\nfunc helper() {}\ntype Config struct {\n").map((s) => `${s.name} ${s.exported}`)).toEqual(["Start true", "helper false", "Config true"]);
    expect(symbolsOf("rs", "pub struct Parser {\n}\npub(crate) fn parse() {}\nfn local() {}\nimpl Display for Parser {\n").map((s) => s.name)).toEqual(["Parser", "parse", "local"]);
    const tracked = new Set(["src/a/b.ts", "src/c.ts", "src/d/index.ts", "pkg/m.py", "pkg/__init__.py"]);
    expect(importsOf("src/a/x.ts", "ts", 'import { y } from "./b.js";\nimport z from "../c";\nconst d = await import("../d");\nimport "react";', tracked)).toEqual(["src/a/b.ts", "src/c.ts", "src/d/index.ts"]);
    expect(importsOf("pkg/n.py", "py", "from .m import thing\nfrom . import x\n", tracked)).toEqual(["pkg/m.py", "pkg/__init__.py"]);
    expect(words("getUserName from user_session.ts")).toEqual(["user", "name", "user", "session"]); // "get", "from", "ts": too common
  });
});

describe("the map", () => {
  test("built from HEAD, skipping dependencies; overview of commands, tests and conventions", async () => {
    write(PROJECT);
    const map = (await buildRepoMap(root))!;
    expect(map.head).toBe(git(root, "rev-parse", "HEAD"));
    expect(map.files["node_modules/dep/index.js"]!.symbols).toEqual([]); // listed, never read
    expect(map.files["src/index.ts"]!.imports).toEqual(["src/auth/session.ts"]);
    expect(map.files["src/auth/session.test.ts"]!.test).toBe(true);
    const ov = overviewText(map);
    expect(ov).toContain("Entry points: src/index.ts");
    expect(ov).toContain("test: `pnpm test` · build: `pnpm run build` · package manager pnpm");
    expect(ov).toContain("Tests: vitest, in src/auth/, named *.test.*");
    expect(ov).toContain("Conventions: ES modules, TypeScript (strict), 2-space indent");
    expect(loadRepoMap(root)?.head).toBe(map.head);
  });

  test("updates incrementally: unchanged files are kept, changed ones read again; uncommitted edits wait for a commit", async () => {
    write(PROJECT);
    const first = (await buildRepoMap(root))!;
    writeFileSync(join(root, "src/util/crypto.ts"), "export function hashToken(t: string) {\n  return t;\n}\nexport function verifyToken() {}\n");
    expect((await buildRepoMap(root))!.files["src/util/crypto.ts"]!.symbols.map((s) => s.name)).toEqual(["hashToken"]); // HEAD hasn't moved
    git(root, "add", "-A");
    git(root, ...YXU_IDENTITY, "commit", "-qm", "y");
    const second = (await buildRepoMap(root))!;
    expect(second.files["src/util/crypto.ts"]!.symbols.map((s) => s.name)).toEqual(["hashToken", "verifyToken"]);
    expect(second.files["src/billing/invoice.ts"]!.blob).toBe(first.files["src/billing/invoice.ts"]!.blob);
  });

  test("a slice ranks what the task names, with tests and neighbours, within the budget", async () => {
    write(PROJECT);
    const map = (await buildRepoMap(root))!;
    const ranked = rankFiles(map, "createSession should reject an empty user").map((r) => r.path);
    expect(ranked[0]).toBe("src/auth/session.ts");
    expect(ranked).toContain("src/index.ts"); // imports it
    expect(ranked).not.toContain("src/billing/invoice.ts");
    const s = mapSlice(map, "createSession should reject an empty user", { noOverview: true });
    expect(s).toContain("paths are relative to the repository root");
    expect(s).toContain("- src/auth/session.ts — createSession:5, Session:2, SESSION_TTL:8 (tests: src/auth/session.test.ts)");
    expect(s).not.toContain("internalHelper");
    expect(s).not.toContain("invoice");
    expect(s).not.toContain("shouldNotAppear");
    expect(mapSlice(map, "the InvoiceBuilder in src/billing/invoice.ts")).toContain("- src/billing/invoice.ts — InvoiceBuilder:1");
    expect(mapSlice(map, "createSession", { chars: 300 }).length).toBeLessThanOrEqual(300);
  });
});

describe("agents get the map", () => {
  // Fake `opencode`: does nothing, says done.
  const FAKE = `#!/bin/sh\necho '{"type":"text","sessionID":"s","part":{"type":"text","text":"done"}}'\n`;

  test("each task gets its slice; the orchestrator the overview; both can be turned off", async () => {
    write(PROJECT);
    fakeCli(bin, "opencode", FAKE);
    await buildRepoMap(root);
    const cfg = parseConfig("agents:\n  coder: { cli: opencode }\n", join(root, "yxu.yaml"));
    const r = await new TaskOps(cfg, root, new Session(), {}).delegate("coder", "Make createSession reject an empty user");
    const prompt = JSON.parse(readFileSync(join(root, ".yxu", "runs", r.taskId, "result.json"), "utf8")).prompt as string;
    expect(prompt).toContain("use paths relative to it, never absolute paths");
    expect(prompt.indexOf("## Repo map")).toBeLessThan(prompt.indexOf("TASK:\nMake createSession"));
    expect(prompt).toContain("- src/auth/session.ts — createSession:5");
    expect(buildContextPrompt(cfg, root).text).toContain("## Repo map (yxu keeps it current; find_code(query) searches it)\nLayout: src/");

    const off = parseConfig("agents:\n  coder: { cli: opencode }\ncontext: { repo_map: false }\n", join(root, "yxu.yaml"));
    const r2 = await new TaskOps(off, root, new Session(), {}).delegate("coder", "Make createSession reject an empty user");
    expect(JSON.parse(readFileSync(join(root, ".yxu", "runs", r2.taskId, "result.json"), "utf8")).prompt).not.toContain("## Repo map");
    expect(buildContextPrompt(off, root).text).not.toContain("## Repo map");
  }, 30_000);
});
