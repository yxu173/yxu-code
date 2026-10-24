import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { git, YXU_IDENTITY } from "../src/git.ts";
import { Session } from "../src/ops.ts";
import type { RunOutcome } from "../src/orchestrator/run.ts";
import { App, type Engine } from "../src/tui/app.ts";
import { paletteFor } from "../src/tui/commands.ts";
import { createTheme } from "../src/tui/theme.ts";
import type { Frame } from "../src/tui/view.ts";
import { expandCommand, loadUserCommands } from "../src/user-commands.ts";
import { testCatalog } from "./helpers.ts";

let root: string;
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const tick = () => Bun.sleep(5);

const YAML = `agents:
  coder: { cli: opencode }
  helper: { cli: claude, model: haiku }
workflows:
  default: { mode: auto }
  release:
    mode: pipeline
    description: cut a release
    inputs: { version: { description: x.y.z }, notes: { default: none } }
    steps: [{ id: ask, type: gate, message: "Release {{inputs.version}}?" }]
`;
const cfg = () => parseConfig(YAML, join(root, "yxu.yaml"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-tuiwf-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "yxu.yaml"), YAML);
  writeFileSync(join(root, "app.ts"), "x");
  mkdirSync(join(root, ".yxu", "commands"), { recursive: true });
  writeFileSync(join(root, ".yxu", "commands", "add-tests.md"), "---\ndescription: Add tests for a file\nargs: [file]\nagents: [coder]\n---\nWrite tests for {{file}}. Run {{settings.verify}}.\n");
  writeFileSync(join(root, ".yxu", "commands", "release.md"), "---\ndescription: Cut a release\nkind: workflow\nworkflow: release\nargs: [version]\n---\n");
  writeFileSync(join(root, ".yxu", "commands", "hello.md"), "---\ncommand: echo hello {{name}}\nargs: [{ name: name, default: world }]\n---\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type RunArgs = Parameters<Engine["run"]>[0];

function setup() {
  const runs: RunArgs[] = [];
  const answers: boolean[] = [];
  const engine: Engine = {
    async run(o) {
      runs.push(o);
      if (o.workflow.mode === "pipeline" && o.gate) answers.push(await o.gate(`Release ${o.inputs?.version}?`, "ask"));
      return { runId: "r", ok: true, finalText: "done", costUsd: 0, session: new Session() } as RunOutcome;
    },
  };
  let frame: Frame = { rows: [] };
  const app = new App({
    cfg: cfg(),
    root,
    theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
    engine,
    historyFile: null,
    catalog: testCatalog(),
    draw: (f) => (frame = f),
    size: () => ({ width: 130, height: 44 }),
    exit: () => {},
  });
  const screen = () => {
    app.render();
    return strip(frame.rows.join("\n"));
  };
  return { app, screen, runs, answers };
}

describe("custom commands", () => {
  test("load from .yxu/commands; kinds, args and errors", () => {
    writeFileSync(join(root, ".yxu", "commands", "broken.md"), "---\nworkflow: nope\n---\nx\n");
    writeFileSync(join(root, ".yxu", "commands", "help.md"), "---\ndescription: shadow\n---\nx\n");
    const { commands, errors } = loadUserCommands(root, cfg(), ["help"]);
    expect(commands.map((c) => `${c.name}:${c.kind}`)).toEqual(["add-tests:prompt", "hello:shell", "release:workflow"]);
    expect(errors.join("\n")).toMatch(/broken\.md: unknown workflow "nope"/);
    expect(errors.join("\n")).toMatch(/\/help is a built-in command/);

    const add = commands[0]!;
    expect(add.args[0]).toMatchObject({ name: "file", complete: "file", required: true });
    const x = expandCommand(add, ["src/a b.ts"], { ...cfg(), settings: { ...cfg().settings, verify: "npm test" } });
    expect(x).toMatchObject({ kind: "prompt", goal: "Write tests for src/a b.ts. Run npm test." });
    expect(x.kind === "prompt" && x.workflow?.allowed_agents).toEqual(["coder"]);
    expect(() => expandCommand(add, [], cfg())).toThrow(/needs <file>.*usage: \/add-tests <file>/);
    expect(expandCommand(commands[1]!, ["it's me"], cfg())).toEqual({ kind: "shell", command: `echo hello 'it'\\''s me'` });
    expect(expandCommand(commands[1]!, [], cfg())).toEqual({ kind: "shell", command: "echo hello world" });
    expect(expandCommand(commands[2]!, ["1.2.0"], cfg())).toMatchObject({ kind: "workflow", inputs: { version: "1.2.0" } });
  });

  test("they appear in the palette, complete files, show in help, and run", async () => {
    const { app, screen, runs } = setup();
    expect(paletteFor(app, "/add")!.items[0]).toMatchObject({ value: "add-tests", label: "/add-tests <file>" });
    expect(paletteFor(app, "/add-tests ap")!.items.map((i) => i.value)).toContain("app.ts");

    app.runCommand("/add-tests app.ts");
    await tick();
    expect(runs[0]).toMatchObject({ goal: "Write tests for app.ts. Run .", workflow: { allowed_agents: ["coder"] } });

    app.runCommand("/hello yxu");
    await Bun.sleep(150);
    expect(screen()).toContain("hello yxu");

    app.store.set({ helpOpen: true, helpScroll: 100 });
    expect(screen()).toContain("/add-tests <file>");
  });
});

describe("workflows in the interface", () => {
  test("/run passes inputs; a gate waits for y / n", async () => {
    const { app, screen, runs, answers } = setup();
    expect(paletteFor(app, "/run release ")!.items.map((i) => i.value)).toEqual(["version=", "notes="]);
    app.runCommand("/run release version=1.2.0 ship it");
    await tick();
    expect(runs[0]).toMatchObject({ goal: "ship it", inputs: { version: "1.2.0" }, workflow: { name: "release" } });
    let s = screen();
    expect(s).toContain("APPROVAL REQUIRED");
    expect(s).toContain("Release 1.2.0?");
    expect(s).toContain("y continue");
    app.input("y");
    await tick();
    expect(answers).toEqual([true]);
    expect(screen()).toContain("Continued at ask");

    app.runCommand("/release 2.0.0"); // the custom command runs the same workflow
    await tick();
    expect(runs[1]).toMatchObject({ inputs: { version: "2.0.0" } });
    app.input("n");
    await tick();
    expect(answers).toEqual([true, false]);
    s = screen();
    expect(s).toContain("Stopped at ask");
  });

  test("/run explains what's wrong", () => {
    const { app, screen } = setup();
    app.runCommand("/run nope");
    expect(screen()).toContain('unknown workflow "nope"');
    app.runCommand("/run default x=1");
    expect(screen()).toContain("inputs are for pipelines");
  });
});

describe("agent approvals in the interface", () => {
  test("questions queue; y allows once, a allows for the session, n denies", async () => {
    const answers: string[] = [];
    const engine: Engine = {
      async run(o) {
        const req = (command: string) => ({ agent: "coder", kind: "execute", title: "bash", command, paths: [] });
        // Two agents ask at the same time.
        const both = await Promise.all([o.render.ask!(req("npm test")), o.render.ask!(req("make"))]);
        answers.push(...both, await o.render.ask!(req("rm -rf build")));
        return { runId: "r", ok: true, finalText: "done", costUsd: 0, session: new Session() } as RunOutcome;
      },
    };
    let frame: Frame = { rows: [] };
    const app = new App({
      cfg: cfg(), root, theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }), engine,
      historyFile: null, catalog: testCatalog(), draw: (f) => (frame = f), size: () => ({ width: 130, height: 44 }), exit: () => {},
    });
    const screen = () => (app.render(), strip(frame.rows.join("\n")));
    app.input("go\r");
    await tick();
    let s = screen();
    expect(s).toContain("AGENT ASKS");
    expect(s).toContain("coder wants to run `npm test`");
    expect(s).toContain("1 more waiting");
    expect(s).toContain("a allow for session");
    app.input("y");
    await tick();
    expect(screen()).toContain("coder wants to run `make`");
    app.input("a");
    await tick();
    app.input("n");
    await tick();
    expect(answers).toEqual(["once", "always", "deny"]);
    s = screen();
    // Notices are Markdown, so the code spans render without backticks.
    expect(s).toContain("Allowed once: coder wants to run npm test");
    expect(s).toContain("Allowed for this session: coder wants to run make");
    expect(s).toContain("Denied: coder wants to run rm -rf build");
    expect(s).not.toContain("AGENT ASKS");
  });
});
