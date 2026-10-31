import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseConfig, spawnPool } from "../src/config.ts";
import { git, YXU_IDENTITY } from "../src/git.ts";
import { Session, TaskOps } from "../src/ops.ts";
import type { RunOutcome } from "../src/orchestrator/run.ts";
import { App, type Engine } from "../src/tui/app.ts";
import { createTheme } from "../src/tui/theme.ts";
import type { Frame } from "../src/tui/view.ts";
import { fakeCli, pathWith, testCatalog } from "./helpers.ts";

const TEAM = "agents:\n  coder: { cli: opencode, model: opencode/a }\n  helper: { cli: claude, model: haiku }\n  acp1: { cli: acp, command: [x] }\ncontext: { repo_map: false }\n";

describe("the spawn pool", () => {
  test("by default the cli/model pairs your agents use; or exactly what spawn.models says", () => {
    expect(spawnPool(parseConfig(TEAM, "x"))).toEqual({ opencode: ["opencode/a"], claude: ["haiku"] });
    expect(spawnPool(parseConfig(`${TEAM}spawn:\n  models: { claude: [sonnet, opus] }\n`, "x"))).toEqual({ claude: ["sonnet", "opus"] });
    expect(() => parseConfig(`${TEAM}spawn:\n  models: { acp: [x] }\n`, "x")).toThrow(/need a command, so they can't be spawned/);
    expect(() => parseConfig(`${TEAM}spawn:\n  models: { cursor: [x] }\n`, "x")).toThrow(/unknown cli "cursor"/);
  });
});

let root: string;
let bin: string;
const origPath = process.env.PATH;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-spawn-"));
  bin = mkdtempSync(join(tmpdir(), "yxu-spawn-bin-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README"), "x\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
  // Fake opencode: logs its arguments on one line, writes a file, says done.
  fakeCli(bin, "opencode", `#!/bin/sh\nprintf '%s' "$*" | tr '\\n' ' ' >> "${bin}/calls"; echo >> "${bin}/calls"\necho made > made.txt\necho '{"type":"text","sessionID":"s","part":{"type":"text","text":"done"}}'\necho '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{"input":1,"output":1},"cost":0}}'\n`);
  process.env.PATH = pathWith(bin, origPath);
});
afterEach(() => {
  process.env.PATH = origPath;
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("spawning", () => {
  test("a spawned agent takes tasks like a configured one, with its model and role prompt", async () => {
    const cfg = parseConfig(`${TEAM}spawn:\n  models: { opencode: [opencode/big, opencode/a] }\n`, join(root, "yxu.yaml"));
    const spawned: string[] = [];
    const ops = new TaskOps(cfg, root, new Session(), { hooks: { onSpawn: (n, d) => spawned.push(`${n} ${d.cli} ${d.model}`) } });
    ops.spawn({ name: "sql-migrator", cli: "opencode", model: "opencode/big", role: "Writes database migrations", instructions: "Role: migrations. Never drop columns." });
    expect(spawned).toEqual(["sql-migrator opencode opencode/big"]);
    const r = await ops.delegate("sql-migrator", "Add a users.email index");
    expect(r.ok).toBe(true);
    expect(r.filesChanged).toEqual(["made.txt"]);
    const call = readFileSync(join(bin, "calls"), "utf8");
    expect(call).toContain("--model opencode/big");
    expect(call).toContain("Role: migrations. Never drop columns.");

    ops.spawn({ name: "looker", cli: "opencode", model: "opencode/a", role: "Reviews", readOnly: true });
    await ops.delegate("looker", "Review it");
    expect(readFileSync(join(bin, "calls"), "utf8").trim().split("\n")[1]).toContain("--agent plan");
  }, 30_000);

  test("only what you allowed, within the limit, never over a configured agent's name", () => {
    const cfg = parseConfig(`${TEAM}spawn:\n  models: { opencode: [opencode/a] }\n  max: 2\n`, join(root, "yxu.yaml"));
    const ops = new TaskOps(cfg, root, new Session(), {});
    expect(() => ops.spawn({ name: "x", cli: "claude", model: "opus", role: "r" })).toThrow(/Provider "claude" isn't in the pool the user allowed. Allowed: opencode \(opencode\/a\)/);
    expect(() => ops.spawn({ name: "x", cli: "opencode", model: "opencode/huge", role: "r" })).toThrow(/Model "opencode\/huge" isn't allowed for opencode. Allowed: opencode\/a/);
    expect(() => ops.spawn({ name: "coder", cli: "opencode", model: "opencode/a", role: "r" })).toThrow(/is a configured agent already/);
    expect(() => ops.spawn({ name: "Bad Name", cli: "opencode", model: "opencode/a", role: "r" })).toThrow(/isn't a usable name/);
    ops.spawn({ name: "one", cli: "opencode", model: "opencode/a", role: "r" });
    ops.spawn({ name: "two", cli: "opencode", model: "opencode/a", role: "r" });
    ops.spawn({ name: "one", cli: "opencode", model: "opencode/a", role: "redefined" }); // same name: replaced, not counted
    expect(() => ops.spawn({ name: "three", cli: "opencode", model: "opencode/a", role: "r" })).toThrow(/already spawned 2 subagents/);
    const off = new TaskOps(parseConfig(`${TEAM}spawn: { enabled: false }\n`, join(root, "yxu.yaml")), root, new Session(), {});
    expect(() => off.spawn({ name: "x", cli: "opencode", model: "opencode/a", role: "r" })).toThrow(/turned off/);
  });

  test("spawned agents stay for the session: later runs (new TaskOps) can use them", async () => {
    const cfg = parseConfig(TEAM, join(root, "yxu.yaml"));
    const session = new Session();
    new TaskOps(cfg, root, session, {}).spawn({ name: "fast", cli: "opencode", model: "opencode/a", role: "quick fixes" });
    const r = await new TaskOps(cfg, root, session, {}).delegate("fast", "fix it");
    expect(r.ok).toBe(true);
    await expect(new TaskOps(cfg, root, new Session(), {}).delegate("fast", "fix it")).rejects.toThrow(/Unknown or disallowed agent "fast"/);
  }, 30_000);
});

describe("/spawn in the interface", () => {
  test("shows the pool, adds and removes models, turns spawning off; spawned agents appear in the panel", async () => {
    const engine: Engine = {
      async run({ session, cfg, render, abort }) {
        const ops = new TaskOps(cfg, root, session, { hooks: render.hooks, signal: abort.signal });
        ops.spawn({ name: "reviewer2", cli: "claude", model: "haiku", role: "A second opinion", readOnly: true });
        return { runId: "r", ok: true, finalText: "ok", costUsd: 0, session } as RunOutcome;
      },
    };
    let frame: Frame = { rows: [] };
    const app = new App({ cfg: parseConfig(TEAM, join(root, "yxu.yaml")), root, theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }), engine, historyFile: null, catalog: testCatalog(), draw: (f) => (frame = f), size: () => ({ width: 140, height: 50 }), exit: () => {} });
    const screen = () => (app.render(), frame.rows.join("\n"));
    const notes = () => app.store.state.entries.flatMap((e) => (e.kind === "notice" ? [e.text] : e.kind === "error" ? [`ERR ${e.message}`] : []));

    app.runCommand("/spawn");
    expect(notes().at(-1)).toContain("(pool taken from your agents)");
    expect(notes().at(-1)).toContain("- **opencode**: `opencode/a`");
    app.runCommand("/spawn add claude sonnet");
    expect(spawnPool(app.cfg)).toEqual({ opencode: ["opencode/a"], claude: ["haiku", "sonnet"] });
    app.runCommand("/spawn remove opencode");
    expect(spawnPool(app.cfg)).toEqual({ claude: ["haiku", "sonnet"] });
    app.runCommand("/spawn add acp x");
    expect(notes().at(-1)).toContain("ERR acp agents need a command");

    app.input("go\r");
    await app.idle();
    expect(notes()).toContain("Spawned **reviewer2** (claude · haiku · read-only): A second opinion");
    expect(screen()).toContain("+reviewer2");
    app.runCommand("/spawn");
    expect(notes().at(-1)).toContain("Spawned this session:\n- **reviewer2** — claude · haiku · read-only: A second opinion");

    app.runCommand("/spawn off");
    expect(app.cfg.spawn.enabled).toBe(false);
    app.runCommand("/spawn reset");
    app.runCommand("/save");
    // The pool went back to "from your agents" (no spawn.models), spawning stays off.
    expect(parseYaml(readFileSync(join(root, "yxu.yaml"), "utf8")).spawn).toEqual({ enabled: false });
    app.dispose();
  });
});
