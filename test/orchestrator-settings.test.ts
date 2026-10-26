import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseConfig } from "../src/config.ts";
import { git, YXU_IDENTITY } from "../src/git.ts";
import { fieldNamed, ORCHESTRATOR_FIELDS } from "../src/orchestrator-settings.ts";
import type { RunOutcome } from "../src/orchestrator/run.ts";
import { App, type Engine } from "../src/tui/app.ts";
import { paletteFor } from "../src/tui/commands.ts";
import { createTheme } from "../src/tui/theme.ts";
import type { Frame } from "../src/tui/view.ts";
import { testCatalog } from "./helpers.ts";

const YAML = "# team config\norchestrator:\n  model: opus\nagents:\n  coder: { cli: opencode }\n  planner: { cli: claude, model: sonnet }\n";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-orch-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "yxu.yaml"), YAML);
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const cfg = () => parseConfig(YAML, join(root, "yxu.yaml"));

describe("orchestrator settings", () => {
  test("each field parses, checks, and maps to its config key", () => {
    const c = cfg();
    const set = (name: string, v: string, ...more: string[]) => fieldNamed(name)!.set(c, v, more);
    expect(set("effort", "high")).toMatchObject({ sets: [{ path: ["orchestrator", "effort"], value: "high" }] });
    expect(set("effort", "default")).toMatchObject({ sets: [{ path: ["orchestrator", "effort"], value: undefined, yaml: null }] });
    expect(set("effort", "huge")).toContain("usage: effort");
    expect(set("budget", "$2.5")).toMatchObject({ sets: [{ value: 2.5 }] });
    expect(set("budget", "-1")).toContain("usage");
    expect(set("turns", "80")).toMatchObject({ sets: [{ path: ["orchestrator", "max_turns"], value: 80 }] });
    expect(set("turns", "1.5")).toContain("usage");
    expect(set("provider", "agent", "planner")).toMatchObject({ sets: [{ value: "agent" }, { path: ["orchestrator", "agent"], value: "planner" }], fresh: true });
    expect(set("provider", "agent")).toContain("usage: provider agent <agent name>");
    expect(set("provider", "agent", "ghost")).toBe('no agent "ghost"');
    expect(set("provider", "gpt")).toContain("provider must be claude, agent");
    expect(set("user-settings", "on")).toMatchObject({ sets: [{ value: true }], fresh: true });
    expect(set("instructions", "Never", "touch", "migrations/")).toMatchObject({ sets: [{ path: ["context", "notes"], value: "Never touch migrations/" }] });
    expect(set("instructions", "clear")).toMatchObject({ sets: [{ yaml: null }] });
    expect(set("model", "sonnet")).toMatchObject({ fresh: true });
    expect(fieldNamed("orchestrator.max_budget_usd")!.name).toBe("budget");
    expect(ORCHESTRATOR_FIELDS.map((f) => f.name)).toEqual(["model", "effort", "budget", "turns", "provider", "agent", "user-settings", "instructions"]);
  });
});

describe("/orchestrator", () => {
  test("shows every setting with where it comes from; changes apply to the next run and /save keeps them", async () => {
    const runs: { model: string; effort?: string; notes?: string; resume?: string }[] = [];
    const engine: Engine = {
      async run({ cfg: c, session, resume }) {
        runs.push({ model: c.orchestrator.model, effort: c.orchestrator.effort, notes: c.context.notes, resume });
        return { runId: "r", ok: true, finalText: "ok", costUsd: 0, session, sdkSessionId: "s1" } as RunOutcome;
      },
    };
    let frame: Frame = { rows: [] };
    const app = new App({ cfg: cfg(), root, theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }), engine, historyFile: null, catalog: testCatalog(), draw: (f) => (frame = f), size: () => ({ width: 140, height: 60 }), exit: () => {} });
    const notes = () => app.store.state.entries.flatMap((e) => (e.kind === "notice" ? [e.text] : e.kind === "error" ? [`ERR ${e.message}`] : []));

    app.runCommand("/orchestrator");
    let n = notes().at(-1)!;
    expect(n).toContain("- **model** `opus`  · yxu.yaml — the Claude model that plans, delegates and reviews");
    expect(n).toContain("- **effort** `default`  · default");
    expect(n).toContain("- **prompt** built-in");

    app.input("hi\r");
    await app.idle();
    app.runCommand("/orchestrator effort high");
    app.runCommand("/orchestrator instructions Keep PRs small");
    app.runCommand("/orchestrator turns lots");
    expect(notes().at(-1)).toBe("ERR usage: turns <n>|off");
    app.input("again\r");
    await app.idle();
    expect(runs.at(-1)).toEqual({ model: "opus", effort: "high", notes: "Keep PRs small", resume: "s1" }); // same conversation
    app.runCommand("/orchestrator model sonnet");
    app.input("third\r");
    await app.idle();
    expect(runs.at(-1)).toMatchObject({ model: "sonnet", resume: undefined }); // a new model starts fresh

    app.runCommand("/orchestrator provider agent planner");
    expect(notes().at(-1)).toContain("Auto workflows (like default) still need provider claude");
    app.runCommand("/orchestrator");
    n = notes().at(-1)!;
    expect(n).toContain("- **effort** `high`  · this session, unsaved");
    expect(n).toContain("- **provider** `agent (planner)`  · this session, unsaved");
    app.runCommand("/orchestrator prompt");
    expect(notes().at(-1)).toContain("# You are the yxu orchestrator");
    expect(notes().at(-1)).toContain("## Standing notes from the user (yxu.yaml)\nKeep PRs small");

    app.runCommand("/save");
    const saved = readFileSync(join(root, "yxu.yaml"), "utf8");
    expect(saved).toStartWith("# team config\n");
    expect(parseYaml(saved).orchestrator).toEqual({ model: "sonnet", effort: "high", provider: "agent", agent: "planner" });
    expect(parseYaml(saved).context).toEqual({ notes: "Keep PRs small" });

    expect(paletteFor(app, "/orchestrator ")!.items.map((i) => i.value)).toEqual([...ORCHESTRATOR_FIELDS.map((f) => f.name), "prompt"]);
    expect(paletteFor(app, "/orchestrator effort ")!.items.map((i) => i.value)).toEqual(["low", "medium", "high", "xhigh", "max", "default"]);
    expect(paletteFor(app, "/orchestrator provider agent ")!.items.map((i) => i.value)).toEqual(["coder", "planner"]);
    void frame;
    app.dispose();
  });
});

describe("yxu orchestrator", () => {
  const cli = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "orchestrator", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    return { out: p.stdout.toString() + p.stderr.toString(), code: p.exitCode };
  };

  test("shows, sets in a layer, refuses bad values, unsets", () => {
    expect(cli().out).toContain("model         opus  · yxu.yaml");
    expect(cli("set", "effort", "high").out).toContain("✓ effort = high in yxu.yaml (project)");
    expect(cli("set", "budget", "3", "--local").out).toContain("in yxu.local.yaml (local)");
    const bad = cli("set", "turns", "many");
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("usage: turns <n>|off");
    expect(cli().out).toContain("budget        $3 per run  · yxu.local.yaml");
    expect(cli("unset", "effort").out).toContain("back to its default");
    expect(parseYaml(readFileSync(join(root, "yxu.yaml"), "utf8")).orchestrator).toEqual({ model: "opus" });
    expect(readFileSync(join(root, "yxu.yaml"), "utf8")).toStartWith("# team config\n");
    expect(cli("prompt").out).toContain("# You are the yxu orchestrator");
  }, 30_000);
});
