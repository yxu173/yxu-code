import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { generatePacks, GEN_FILE } from "../scripts/gen-packs.ts";
import { parseConfig } from "../src/config.ts";
import { explainRows } from "../src/config-explain.ts";
import { loadLayers } from "../src/config-layers.ts";
import { packSchemaText } from "../src/config-schema.ts";
import { git, YXU_IDENTITY } from "../src/git.ts";
import { detectPacks, initYaml, KNOWN_AGENTS } from "../src/init.ts";
import { PROVIDERS, teamYaml } from "../src/team.ts";
import { addPack, packStatus, removePack, restorePacks, updatePacks, type PackIO } from "../src/pack-install.ts";
import { lockPath, readLock } from "../src/packs.ts";
import { prompt, SUBAGENT_PREAMBLE } from "../src/prompts.ts";
import { parseSource } from "../src/sources.ts";
import { needsTrust } from "../src/trust.ts";
import { loadTheme } from "../src/tui/themes.ts";
import { loadUserCommands } from "../src/user-commands.ts";

let root: string;
let home: string;
let work: string;
const printed: string[] = [];
const io: PackIO = { print: (l) => printed.push(l), dim: (s) => s };

const TEAM = `agents:
  coder: { cli: commandcode, model: deepseek/deepseek-v4-flash }
  reviewer: { cli: claude, model: sonnet }
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-packs-"));
  home = mkdtempSync(join(tmpdir(), "yxu-packs-home-"));
  work = mkdtempSync(join(tmpdir(), "yxu-packs-src-"));
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.XDG_CACHE_HOME = join(home, "cache");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "yxu.yaml"), TEAM);
  printed.length = 0;
});
afterEach(() => {
  for (const d of [root, home, work]) rmSync(d, { recursive: true, force: true });
});

const write = (base: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(base, rel, ".."), { recursive: true });
    writeFileSync(join(base, rel), text);
  }
};

/** A git repo holding a pack under pack/, committed. Returns its file:// source. */
function packRepo(files: Record<string, string>): string {
  const repo = join(work, "repo");
  mkdirSync(repo, { recursive: true });
  if (!existsSync(join(repo, ".git"))) git(repo, "init", "-q", "-b", "main");
  write(join(repo, "pack"), files);
  git(repo, "add", ".");
  git(repo, ...YXU_IDENTITY, "commit", "-qm", "update");
  return `${pathToFileURL(repo).href}//pack`;
}

const REVIEW_PACK = {
  "yxu-pack.yaml": `name: review
version: 0.1.0
description: strict review
config:
  hooks:
    on_complete: ["echo done"]
  agents:
    critic: { cli: claude, model: opus }
`,
  "workflows/strict.yaml": `mode: pipeline
steps:
  - id: r
    type: review
    fix_agent: default
  - id: again
    type: workflow
    workflow: quick
`,
  "workflows/quick.yaml": `mode: pipeline
steps:
  - id: q
    type: delegate
    agent: default
    prompt: "quick look at {{goal}}"
`,
  "commands/check.md": "---\nworkflow: strict\n---\nReview {{args}}\n",
  "themes/dusk.yaml": "extends: light\ncolors: { cyan: '#123456' }\n",
};

describe("sources", () => {
  test("parses starter packs, shorthands, git URLs and paths", () => {
    expect(parseSource("python")).toMatchObject({ kind: "builtin", name: "python", spec: "builtin:python" });
    expect(parseSource("builtin:go")).toMatchObject({ kind: "builtin", name: "go" });
    expect(() => parseSource("pyhton")).toThrow(/not a starter pack.*python/);
    expect(parseSource("github:acme/yxu-python")).toMatchObject({ kind: "git", url: "https://github.com/acme/yxu-python.git", subpath: undefined, ref: undefined });
    expect(parseSource("github:acme/presets/python/base.yaml@v2")).toMatchObject({ url: "https://github.com/acme/presets.git", subpath: "python/base.yaml", ref: "v2" });
    expect(parseSource("gitlab:a/b#main")).toMatchObject({ url: "https://gitlab.com/a/b.git", ref: "main" });
    expect(parseSource("https://example.com/x.git//packs/a#v1")).toMatchObject({ url: "https://example.com/x.git", subpath: "packs/a", ref: "v1" });
    expect(parseSource("git@github.com:a/b.git")).toMatchObject({ kind: "git", url: "git@github.com:a/b.git" });
    expect(parseSource("./mine", "/repo")).toMatchObject({ kind: "local", path: resolve("/repo", "mine") });
    expect(parseSource("C:\\Users\\me\\pack")).toMatchObject({ kind: "local" });
    expect(() => parseSource("what is this")).toThrow(/can't tell where/);
  });

  test("the embedded starter packs and the pack schema are up to date (run: bun run packs, bun run schema)", () => {
    expect(readFileSync(GEN_FILE, "utf8")).toBe(generatePacks());
    expect(readFileSync(join(import.meta.dir, "..", "schema", "yxu-pack.schema.json"), "utf8")).toBe(packSchemaText());
  });

  test("every starter pack's manifest passes its JSON Schema and installs cleanly", async () => {
    const validate = new Ajv({ strict: false }).compile(JSON.parse(packSchemaText()));
    for (const name of ["go", "node", "python", "rust"]) {
      const manifest = parseYaml(readFileSync(join(import.meta.dir, "..", "packs", name, "yxu-pack.yaml"), "utf8"));
      expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
      await addPack(root, name, { scope: "project" }, io);
    }
    const cfg = loadLayers(root).config;
    expect(Object.keys(cfg.workflows).filter((w) => w.includes(":")).sort()).toEqual(["go:add-tests", "node:add-tests", "python:add-tests", "rust:add-tests"]);
  });
});

describe("installing packs", () => {
  test("a starter pack adds namespaced workflows and commands, a verify command and prompt text", async () => {
    const pack = await addPack(root, "python", { scope: "project" }, io);
    expect(pack?.dir).toBe(join(root, ".yxu", "packs", "python"));
    const lock = readLock(lockPath("project", root));
    expect(lock.packs.python).toMatchObject({ source: "builtin:python", version: "1.0.0" });
    expect(lock.packs.python!.integrity).toMatch(/^sha256-/);

    const loaded = loadLayers(root);
    const cfg = loaded.config;
    expect(cfg.settings.verify).toContain("pytest");
    expect(explainRows(loaded, root, "settings.verify")[0]!.from).toBe("pack python (.yxu/packs/python)");
    // `agent: default` → the first agent (no settings.default_agent here).
    const steps = cfg.workflows["python:add-tests"]!.steps!;
    expect(steps[0]).toMatchObject({ type: "delegate", agent: "coder" });
    expect(steps[1]).toMatchObject({ type: "verify", fix_agent: "coder" });

    const { commands, errors } = loadUserCommands(root, cfg);
    expect(errors).toEqual([]);
    expect(commands.map((c) => c.name)).toEqual(["python:add-tests", "python:lint"]);
    expect(commands[0]).toMatchObject({ kind: "workflow", workflow: "python:add-tests", scope: "project" });

    const preamble = prompt(root, "subagent-preamble", SUBAGENT_PREAMBLE);
    expect(preamble.startsWith(SUBAGENT_PREAMBLE)).toBe(true);
    expect(preamble).toContain("This is a Python project.");

    expect(() => addPack(root, "python", { scope: "project" }, io)).toThrow(/already installed/);
  });

  test("settings.default_agent picks the agent for `agent: default`; your own files override a pack", async () => {
    writeFileSync(join(root, "yxu.yaml"), `${TEAM}settings:\n  default_agent: reviewer\n  verify: make check\n`);
    await addPack(root, "go", { scope: "project" }, io);
    const cfg = loadLayers(root).config;
    expect(cfg.workflows["go:add-tests"]!.steps![0]).toMatchObject({ agent: "reviewer" });
    expect(cfg.settings.verify).toBe("make check");
  });

  test("a git pack: pinned by commit, workflow calls and command workflows renamed, themes usable", async () => {
    const src = packRepo(REVIEW_PACK);
    const pack = await addPack(root, src, { scope: "project" }, io);
    expect(pack?.name).toBe("review");
    const entry = readLock(lockPath("project", root)).packs.review!;
    expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.source).toBe(src);

    const cfg = loadLayers(root).config;
    expect(Object.keys(cfg.workflows)).toContain("review:strict");
    expect(cfg.workflows["review:strict"]!.steps![1]).toMatchObject({ type: "workflow", workflow: "review:quick" });
    expect(cfg.agents.critic).toBeDefined();
    const { commands } = loadUserCommands(root, cfg);
    expect(commands.find((c) => c.name === "review:check")?.workflow).toBe("review:strict");
    expect(loadTheme("dusk", root).file).toBe(join(root, ".yxu", "packs", "review", "themes", "dusk.yaml"));
  });

  test("a project pack's commands wait for trust like the repo's own config", async () => {
    await addPack(root, packRepo(REVIEW_PACK), { scope: "project" }, io);
    const cfg = { ...loadLayers(root).config, trusted: false };
    expect(needsTrust(cfg)).toContain("on_complete hooks");
  });

  test("a user pack is yours: trusted, and below your user file and the project", async () => {
    const src = packRepo({ ...REVIEW_PACK, "yxu-pack.yaml": REVIEW_PACK["yxu-pack.yaml"].replace("hooks:", "settings:\n    concurrency: 7\n  hooks:") });
    await addPack(root, src, { scope: "user" }, io);
    expect(existsSync(join(home, "config", "yxu", "packs", "review", "yxu-pack.yaml"))).toBe(true);
    expect(readLock(join(home, "config", "yxu", "yxu.lock")).packs.review).toBeDefined();
    let cfg = loadLayers(root).config;
    expect(cfg.settings.concurrency).toBe(7);
    expect(needsTrust({ ...cfg, trusted: false })).toEqual([]);
    writeFileSync(join(root, "yxu.yaml"), `${TEAM}settings:\n  concurrency: 2\n`);
    cfg = loadLayers(root).config;
    expect(cfg.settings.concurrency).toBe(2);
  });

  test("a pack that breaks the config is rolled back", async () => {
    const before = existsSync(lockPath("project", root)) ? readFileSync(lockPath("project", root), "utf8") : undefined;
    const src = packRepo({ "yxu-pack.yaml": "name: broken\nconfig:\n  settings:\n    resolver: nobody\n" });
    await expect(addPack(root, src, { scope: "project" }, io)).rejects.toThrow(/doesn't fit your config, so nothing was changed[\s\S]*nobody/);
    expect(existsSync(join(root, ".yxu", "packs", "broken"))).toBe(false);
    expect(existsSync(lockPath("project", root)) ? readFileSync(lockPath("project", root), "utf8") : undefined).toBe(before);
  });

  test("manifests are checked: names, unknown fields, yxu version, config.extends", async () => {
    const tryPack = (manifest: string) => addPack(root, packRepo({ "yxu-pack.yaml": manifest }), { scope: "project" }, io);
    await expect(tryPack("name: Bad Name\n")).rejects.toThrow(/lowercase words/);
    await expect(tryPack("name: ok\nhooks: {}\n")).rejects.toThrow(/Unrecognized key/);
    await expect(tryPack('name: ok\nyxu: ">=99.0.0"\n')).rejects.toThrow(/needs yxu >=99.0.0/);
    await expect(tryPack("name: ok\nconfig:\n  extends: [x.yaml]\n")).rejects.toThrow(/config.extends is not allowed/);
    await expect(addPack(root, work, { scope: "project" }, io)).rejects.toThrow(/not a yxu pack/);
  });

  test("--as installs under another name and namespace", async () => {
    await addPack(root, "rust", { scope: "project", as: "rs" }, io);
    expect(Object.keys(loadLayers(root).config.workflows)).toContain("rs:add-tests");
  });
});

describe("keeping packs in step with yxu.lock", () => {
  test("update re-pins a newer commit and lists changed files; up to date when nothing changed", async () => {
    const src = packRepo(REVIEW_PACK);
    await addPack(root, src, { scope: "project" }, io);
    const first = readLock(lockPath("project", root)).packs.review!.commit;
    expect(updatePacks(root, ["review"], io)).toBe(0);
    expect(printed.at(-1)).toMatch(/review is up to date/);

    packRepo({ ...REVIEW_PACK, "yxu-pack.yaml": REVIEW_PACK["yxu-pack.yaml"].replace("0.1.0", "0.2.0"), "commands/new.md": "Do {{args}}\n" });
    expect(updatePacks(root, [], io)).toBe(1);
    const entry = readLock(lockPath("project", root)).packs.review!;
    expect(entry.commit).not.toBe(first);
    expect(entry.version).toBe("0.2.0");
    expect(printed.join("\n")).toMatch(/updated review 0.1.0 → 0.2.0[\s\S]*\+ commands\/new.md[\s\S]*~ yxu-pack.yaml/);
  });

  test("status notices hand edits and missing folders; install restores at the locked commit", async () => {
    const src = packRepo(REVIEW_PACK);
    await addPack(root, src, { scope: "project" }, io);
    const locked = readLock(lockPath("project", root)).packs.review!;
    expect(packStatus(root).map((s) => s.state)).toEqual(["ok"]);

    writeFileSync(join(root, ".yxu", "packs", "review", "commands", "check.md"), "edited {{args}}\n");
    expect(packStatus(root)[0]!.state).toBe("modified");

    // A newer upstream commit must not leak into a restore: the lock wins.
    packRepo({ ...REVIEW_PACK, "commands/later.md": "later\n" });
    rmSync(join(root, ".yxu", "packs", "review"), { recursive: true });
    expect(packStatus(root)[0]!.state).toBe("missing");
    expect(restorePacks(root, io)).toBe(1);
    expect(packStatus(root)[0]!.state).toBe("ok");
    expect(existsSync(join(root, ".yxu", "packs", "review", "commands", "later.md"))).toBe(false);
    expect(readLock(lockPath("project", root)).packs.review!.commit).toBe(locked.commit);
  });

  test("remove deletes the folder and the lock entry", async () => {
    await addPack(root, "node", { scope: "project" }, io);
    removePack(root, "node", io);
    expect(existsSync(join(root, ".yxu", "packs", "node"))).toBe(false);
    expect(readLock(lockPath("project", root)).packs.node).toBeUndefined();
    expect(loadLayers(root).config.workflows["node:add-tests"]).toBeUndefined();
    expect(() => removePack(root, "node", io)).toThrow(/no pack named node/);
  });
});

describe("extends", () => {
  test("local bases merge under the file, nest, and may not loop", () => {
    write(root, {
      "config/base.yaml": "extends: ./deeper.yaml\nsettings:\n  concurrency: 4\ncontext:\n  notes: base\n",
      "config/deeper.yaml": "settings:\n  concurrency: 9\n  max_diff_chars: 5000\n",
      "yxu.yaml": `extends: [./config/base.yaml]\n${TEAM}context:\n  notes: mine\n`,
    });
    const cfg = loadLayers(root).config;
    expect(cfg.settings.concurrency).toBe(4);
    expect(cfg.settings.max_diff_chars).toBe(5000);
    expect(cfg.context.notes).toBe("mine");

    write(root, { "config/deeper.yaml": "extends: ./base.yaml\n" });
    expect(() => loadLayers(root)).toThrow(/extends loops/);
    write(root, { "yxu.yaml": `extends: ./missing.yaml\n${TEAM}` });
    expect(() => loadLayers(root)).toThrow(/missing.yaml is not a file/);
    write(root, { "yxu.yaml": `extends: python\n${TEAM}` });
    expect(() => loadLayers(root)).toThrow(/yxu add python/);
  });

  test("a remote base is fetched once, pinned in yxu.lock, and served from the cache at the locked commit", () => {
    const repo = join(work, "presets");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    write(repo, { "team.yaml": "version: 1\nsettings:\n  concurrency: 6\n" });
    git(repo, "add", ".");
    git(repo, ...YXU_IDENTITY, "commit", "-qm", "one");
    const spec = `${pathToFileURL(repo).href}//team.yaml`;
    writeFileSync(join(root, "yxu.yaml"), `extends: ["${spec}"]\n${TEAM}`);

    expect(loadLayers(root).config.settings.concurrency).toBe(6);
    const pinned = readLock(lockPath("project", root)).extends[spec]!;
    expect(pinned.commit).toMatch(/^[0-9a-f]{40}$/);

    // Upstream moves on; the team keeps the locked version until it re-pins.
    write(repo, { "team.yaml": "version: 1\nsettings:\n  concurrency: 8\n" });
    git(repo, ...YXU_IDENTITY, "commit", "-qam", "two");
    expect(loadLayers(root).config.settings.concurrency).toBe(6);
    rmSync(join(home, "cache"), { recursive: true, force: true });
    expect(loadLayers(root).config.settings.concurrency).toBe(6); // refetched at the locked commit

    updatePacks(root, [], io, { extends: true });
    expect(loadLayers(root).config.settings.concurrency).toBe(8);
    expect(readLock(lockPath("project", root)).extends[spec]!.commit).not.toBe(pinned.commit);
  });
});

describe("init", () => {
  test("the written yxu.yaml is valid for any choice of agents, with or without a pack", async () => {
    for (const agents of [KNOWN_AGENTS, [KNOWN_AGENTS[1]!], [KNOWN_AGENTS[2]!, KNOWN_AGENTS[3]!], []]) {
      for (const extra of [{ verify: "npm test" }, {}]) {
        const cfg = parseConfig(initYaml({ agents, ...extra }), "yxu.yaml");
        const names = Object.keys(cfg.agents);
        expect(names.length).toBe(Math.max(agents.length, 1));
        expect(cfg.settings.default_agent).toBe(names[0]!);
        expect(cfg.workflows.feature!.steps!.some((s) => s.type === "verify")).toBe(Boolean(extra.verify));
      }
    }
    // With a starter pack, the pack supplies the verify command.
    writeFileSync(join(root, "yxu.yaml"), initYaml({ agents: KNOWN_AGENTS, pack: "python" }));
    expect(() => loadLayers(root)).toThrow(/needs a command/);
    await addPack(root, "python", { scope: "project" }, io);
    expect(loadLayers(root).config.workflows.feature!.steps!.map((s) => s.id)).toEqual(["plan", "implement", "verify", "review"]);
    const text = initYaml({ agents: [KNOWN_AGENTS[2]!] });
    expect(text).toContain("command: [gemini, --experimental-acp]");
  });

  test("the team template is valid for any set of CLIs, with roles where they belong", () => {
    const P = (id: string) => PROVIDERS.find((p) => p.id === id)!;
    for (const providers of [[P("commandcode")], [P("opencode"), P("claude")], [P("claude")], [P("gemini")], [P("commandcode"), P("opencode"), P("claude"), P("gemini")]]) {
      for (const extra of [{ verify: "npm test" }, {}]) {
        const cfg = parseConfig(teamYaml({ providers, ...extra }, "# x"), "yxu.yaml");
        const names = Object.keys(cfg.agents);
        expect(names.slice(0, 9)).toEqual(["scout", "coder", "builder", "tester", "debugger", "reviewer", "resolver", "docs", "expert"]);
        expect(names.includes("backup")).toBe(providers.length > 1);
        expect(cfg.agents.scout!.permission).toBe("plan");
        expect(cfg.agents.reviewer!.permission).toBe("plan");
        expect(cfg.agents.coder!.cli).toBe(providers[0]!.cli);
        // Expert roles go to Claude when it is there.
        expect(cfg.agents.expert!.cli).toBe(providers.some((p) => p.cli === "claude") ? "claude" : providers[0]!.cli);
        expect(cfg.settings).toMatchObject({ resolver: "resolver", default_agent: "coder" });
        expect(Object.keys(cfg.workflows)).toEqual(["default", "feature", "bugfix", "review", "explore"]);
        expect(cfg.workflows.feature!.steps!.some((s) => s.type === "verify")).toBe(Boolean(extra.verify));
        expect(cfg.workflows.default!.instructions).toContain(providers.length > 1 ? "`backup`" : "`expert`");
        expect(cfg.workflows.default!.instructions!.includes("`backup`")).toBe(providers.length > 1);
      }
    }
  });

  test("starter packs are suggested from the files in the repo", () => {
    expect(detectPacks(root)).toEqual([]);
    writeFileSync(join(root, "go.mod"), "module x\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    expect(detectPacks(root).map((p) => [p.name, p.file])).toEqual([
      ["go", "go.mod"],
      ["node", "package.json"],
    ]);
  });
});
