import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { git, YXU_IDENTITY } from "../src/git.ts";
import type { RunOutcome } from "../src/orchestrator/run.ts";
import { App, type Engine } from "../src/tui/app.ts";
import { COMMANDS, findCommand, paletteFor } from "../src/tui/commands.ts";
import { testCatalog } from "./helpers.ts";
import { createTheme } from "../src/tui/theme.ts";
import type { Frame } from "../src/tui/view.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const YAML = `# my settings
orchestrator:
  model: opus
agents:
  coder: { cli: opencode, model: x/y }   # main coder
  helper: { cli: claude, model: haiku }
workflows:
  default: { mode: auto }
  quick: { mode: auto, instructions: be quick }
`;

function setup(engine?: Engine) {
  const root = mkdtempSync(join(tmpdir(), "yxu-cmd-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "yxu.yaml"), YAML);
  writeFileSync(join(root, "ARCHITECTURE.md"), "x");
  writeFileSync(join(root, "app.ts"), "x");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
  let frame: Frame = { rows: [] };
  const runs: { concurrency: number; model: string; timeout?: number }[] = [];
  let release: (() => void) | undefined;
  const eng: Engine =
    engine ??
    {
      async run({ session, cfg, abort }) {
        runs.push({ concurrency: cfg.settings.concurrency, model: cfg.orchestrator.model, timeout: cfg.agents.coder?.timeout });
        if (release === undefined) await new Promise<void>((r) => { release = r; abort.signal.addEventListener("abort", () => r()); });
        return { runId: "r", ok: true, finalText: "ok", costUsd: 0, session } as RunOutcome;
      },
    };
  const app = new App({
    cfg: parseConfig(YAML, join(root, "yxu.yaml")),
    root,
    theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
    engine: eng,
    historyFile: null,
    catalog: testCatalog(),
    draw: (f) => (frame = f),
    size: () => ({ width: 120, height: 40 }),
    exit: () => {},
  });
  const screen = () => {
    app.render();
    return strip(frame.rows.join("\n"));
  };
  return { root, app, screen, runs, release: () => release?.(), done: () => { app.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

describe("registry", () => {
  test("names are unique, described, and findable by alias", () => {
    const names = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
    for (const c of COMMANDS) expect(c.description.length).toBeGreaterThan(10);
    expect(findCommand("exit")?.name).toBe("quit");
  });

  test("every command runs without arguments and never throws", () => {
    const { app, done } = setup();
    for (const c of COMMANDS) {
      if (c.name === "quit" || c.name === "doctor") continue; // doctor runs the real agent CLIs
      expect(() => app.runCommand(`/${c.name}`)).not.toThrow();
    }
    app.store.set({ helpOpen: false });
    done();
  });
});

describe("palette", () => {
  test("/ lists every command; typing filters by name first", () => {
    const { app, done } = setup();
    expect(paletteFor(app, "/")!.items.map((i) => i.value)).toEqual(COMMANDS.map((c) => c.name));
    expect(paletteFor(app, "/co")!.items.map((i) => i.value)).toEqual(["config", "commands", "concurrency", "context", "compact", "continue"]);
    expect(paletteFor(app, "/hello world")).toBeUndefined(); // unknown command: no palette
    expect(paletteFor(app, "not a command")).toBeUndefined();
    done();
  });

  test("argument completion: agents, fields, values, workflows, files, tasks", () => {
    const { app, done } = setup();
    expect(paletteFor(app, "/agent ")!.items.map((i) => i.value)).toEqual(["coder", "helper", "new", "remove"]);
    expect(paletteFor(app, "/agent coder ")!.items.map((i) => i.value)).toEqual(["model", "cli", "role", "instructions", "permission", "timeout", "turns"]);
    expect(paletteFor(app, "/agent coder cli ")!.items.map((i) => i.value)).toEqual(["commandcode", "opencode", "claude"]);
    expect(paletteFor(app, "/agent new x ")!.items.map((i) => i.value)).toEqual(["commandcode", "opencode", "claude"]);
    expect(paletteFor(app, "/agent coder permission ")!.items.map((i) => i.value)).toEqual(["yolo", "accept-edits", "plan"]);
    expect(paletteFor(app, "/workflow q")!.items.map((i) => i.value)).toEqual(["quick"]);
    expect(paletteFor(app, "/context add arch")!.items.map((i) => i.value)).toEqual(["ARCHITECTURE.md"]);
    expect(paletteFor(app, "/compact window ")!.items.map((i) => i.value)).toContain("200k");
    app.store.upsertTask({ taskId: "2026-ab12", agent: "coder", state: "ok", title: "t", files: 1, pending: true });
    expect(paletteFor(app, "/apply ")!.items[0]).toMatchObject({ value: "2026-ab12", label: "ab12" });
    expect(paletteFor(app, "/model ")!.hint).toContain("/model [name]");
    done();
  });

  test("typing / opens it, arrows select, enter completes then runs", () => {
    const { app, screen, done } = setup();
    app.input("/mo");
    let s = screen();
    expect(s).toContain("› /model [name]");
    expect(s).toContain("↑↓ select");
    app.input("\r"); // completes "/model " and shows model choices (more input needed)
    expect(app.editor.text).toBe("/model ");
    expect(screen()).toContain("› opus");
    app.key({ name: "down" });
    app.input("\r"); // picks sonnet and runs
    expect(app.cfg.orchestrator.model).toBe("sonnet");
    s = screen();
    expect(s).toContain("Orchestrator model is now sonnet");
    expect(app.store.state.palette).toBeUndefined();
    expect(app.editor.isEmpty).toBe(true);
    done();
  });

  test("tab completes without running; esc closes and enter sends the typed text", () => {
    const { app, done } = setup();
    app.input("/stat\t");
    expect(app.editor.text).toBe("/status");
    expect(app.store.state.entries).toHaveLength(0);
    app.input("\x1b");
    return Bun.sleep(60).then(() => {
      expect(app.store.state.palette).toBeUndefined();
      app.input("\r");
      expect(app.store.state.entries.some((e) => e.kind === "notice" && e.text.includes("**Session**"))).toBe(true);
      done();
    });
  });

  test("free-text arguments submit as typed (no suggestion hijacks enter)", () => {
    const { app, done } = setup();
    app.input("/context notes never edit migrations\r");
    expect(app.cfg.context.notes).toBe("never edit migrations");
    done();
  });
});

describe("controlling everything", () => {
  test("agent, concurrency, budget, effort, verify, resolver reach the next run and /save keeps comments", async () => {
    const { app, root, runs, release, done } = setup();
    for (const line of [
      "/agent coder timeout 5m",
      "/agent coder permission plan",
      "/agent coder turns 30",
      "/agent coder model deepseek/deepseek-v4-pro",
      "/concurrency 5",
      "/budget 2",
      "/effort low",
      "/verify bun test",
      "/resolver helper",
    ]) app.runCommand(line);
    expect(app.cfg.agents.coder).toMatchObject({ timeout: 300_000, permission: "plan", max_turns: 30, model: "deepseek/deepseek-v4-pro" });
    expect(app.cfg.settings).toMatchObject({ concurrency: 5, verify: "bun test", resolver: "helper" });
    expect(app.cfg.orchestrator).toMatchObject({ max_budget_usd: 2, effort: "low" });

    app.input("go\r");
    await Bun.sleep(5);
    expect(runs[0]).toEqual({ concurrency: 5, model: "opus", timeout: 300_000 });

    // Commands work mid-run.
    app.input("/status\r");
    expect(app.store.state.entries.at(-1)).toMatchObject({ kind: "notice" });
    release();
    await app.idle();

    app.runCommand("/save");
    const saved = readFileSync(join(root, "yxu.yaml"), "utf8");
    expect(saved).toContain("# my settings");
    expect(saved).toContain("# main coder");
    const back = parseConfig(saved, "x");
    expect(back.agents.coder).toMatchObject({ timeout: 300_000, permission: "plan", max_turns: 30, model: "deepseek/deepseek-v4-pro" });
    expect(saved).toContain("timeout: 5m"); // written the way the user typed it
    expect(back.settings).toMatchObject({ concurrency: 5, verify: "bun test", resolver: "helper" });
    expect(back.orchestrator).toMatchObject({ max_budget_usd: 2, effort: "low" });
    done();
  });

  test("bad values are refused with a usage line and change nothing", () => {
    const { app, screen, done } = setup();
    app.runCommand("/concurrency 99");
    app.runCommand("/agent coder permission root");
    app.runCommand("/agent ghost model x");
    app.runCommand("/budget -3");
    app.runCommand("/resolver nobody");
    const s = screen();
    expect(s).toContain("usage: /concurrency <1–16>");
    expect(s).toContain("usage: /agent <name> permission yolo|accept-edits|plan");
    expect(s).toContain('unknown agent "ghost"');
    expect(app.cfg.settings.concurrency).toBe(3);
    expect(app.cfg.agents.coder?.permission).toBeUndefined();
    done();
  });

  test("unknown commands suggest close ones", () => {
    const { app, screen, done } = setup();
    app.runCommand("/conc");
    expect(screen()).toContain("did you mean /concurrency");
    done();
  });

  test("/ascii and /motion switch the interface live", () => {
    const { app, screen, done } = setup();
    app.runCommand("/ascii on");
    expect(app.theme.ascii).toBe(true);
    expect(/^[\x20-\x7e\n]*$/.test(screen())).toBe(true);
    app.runCommand("/motion on");
    expect(app.theme.reducedMotion).toBe(false);
    done();
  });

  test("/workflow switches and resets memory; /new divides the conversation", () => {
    const { app, screen, done } = setup();
    app.input("/workflow quick\r");
    expect(screen()).toContain("Workflow is now quick (auto)");
    expect(app.store.state.context.workflow).toBe("quick");
    app.runCommand("/new");
    expect(screen()).toContain("new conversation");
    done();
  });

  test("/agent adds, removes and re-provisions agents, and /save writes them", () => {
    const { app, screen, done, root } = setup();
    app.runCommand("/agent new security claude sonnet");
    app.runCommand("/agent security role Reviews auth and input handling for vulnerabilities");
    app.runCommand("/agent security instructions Report findings with path:line. Change nothing.");
    app.runCommand("/agent security permission plan");
    app.runCommand("/agent coder cli claude");
    app.runCommand("/agent helper model sonnet");
    app.runCommand("/agent remove helper");
    expect(app.cfg.agents.security).toMatchObject({ cli: "claude", model: "sonnet", permission: "plan", description: "Reviews auth and input handling for vulnerabilities" });
    expect(app.cfg.agents.coder).toEqual({ cli: "claude" }); // the opencode model id went with the cli
    expect(app.cfg.agents.helper).toBeUndefined();

    app.runCommand("/agent new security opencode");
    app.runCommand("/agent new Bad opencode");
    app.runCommand("/agent new x acp");
    app.runCommand("/resolver security");
    app.runCommand("/agent remove security");
    const s = screen();
    expect(s).toContain('agent "security" already exists');
    expect(s).toContain('"Bad" can\'t be an agent name');
    expect(s).toContain("acp and generic agents need a command");
    expect(s).toContain("security is still used by settings.resolver");

    app.runCommand("/save");
    expect(screen()).toContain("Saved");
    const saved = readFileSync(join(root, "yxu.yaml"), "utf8");
    expect(saved).toContain("# my settings");
    expect(saved).not.toContain("helper"); // removed from the file that defined it, not set to null
    const back = parseConfig(saved, "x");
    expect(Object.keys(back.agents)).toEqual(["coder", "security"]);
    expect(back.agents.coder).toEqual({ cli: "claude" });
    expect(back.agents.security!.instructions).toBe("Report findings with path:line. Change nothing.");
    done();
  });
});
