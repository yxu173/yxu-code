import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_YAML } from "../src/config.ts";
import { migrateText, saveConfigPatch } from "../src/config-edit.ts";
import { explainRows } from "../src/config-explain.ts";
import { envLayer, loadLayers, originOf, setsLayer } from "../src/config-layers.ts";
import { configJsonSchema, schemaText } from "../src/config-schema.ts";
import { git, YXU_IDENTITY } from "../src/git.ts";
import { App } from "../src/tui/app.ts";
import { paletteFor } from "../src/tui/commands.ts";
import { createTheme } from "../src/tui/theme.ts";
import { testCatalog } from "./helpers.ts";

let root: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-layers-"));
  home = mkdtempSync(join(tmpdir(), "yxu-layers-home-"));
  git(root, "init", "-q", "-b", "main");
  env = { XDG_CONFIG_HOME: home };
  process.env.XDG_CONFIG_HOME = home;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const TEAM = `# team
agents:
  coder: { cli: commandcode, model: deepseek/deepseek-v4-flash, timeout: 15m }
  reviewer: { cli: claude, model: sonnet }
settings:
  concurrency: 3
  resolver: reviewer
`;
const project = (text = TEAM) => writeFileSync(join(root, "yxu.yaml"), text);
const local = (text: string) => writeFileSync(join(root, "yxu.local.yaml"), text);
const user = (text: string) => {
  mkdirSync(join(home, "yxu"), { recursive: true });
  writeFileSync(join(home, "yxu", "config.yaml"), text);
};
const load = (sets?: string[], extraEnv: NodeJS.ProcessEnv = {}) => loadLayers(root, { sets, env: { ...env, ...extraEnv } });

describe("layers", () => {
  test("no files: the starter agents and workflows apply", () => {
    const { config } = load();
    expect(config.source).toBe("(built-in defaults)");
    expect(Object.keys(config.agents)).toContain("coder");
    expect(config.workflows.feature?.mode).toBe("pipeline");
  });

  test("user < project < local < env < flags; maps merge, lists replace", () => {
    user("orchestrator: { model: sonnet, effort: low }\nagents:\n  mine: { cli: opencode }\ncontext: { include: [A.md, B.md] }\n");
    project();
    local("version: 1\norchestrator: { effort: high }\nagents:\n  coder: { model: deepseek/deepseek-v4-pro }\ncontext: { include: [C.md] }\n");
    const { config } = load(["settings.concurrency=7"], { YXU_ORCHESTRATOR_MAX_BUDGET_USD: "2.5" });
    expect(config.orchestrator).toMatchObject({ model: "sonnet", effort: "high", max_budget_usd: 2.5 });
    // local changed only the model; cli and timeout still come from the team file
    expect(config.agents.coder).toMatchObject({ cli: "commandcode", model: "deepseek/deepseek-v4-pro", timeout: 900_000 });
    expect(Object.keys(config.agents).sort()).toEqual(["coder", "mine", "reviewer"]);
    expect(config.context.include).toEqual(["C.md"]);
    expect(config.settings.concurrency).toBe(7);
    expect(config.origins).toMatchObject({
      "orchestrator.model": "user",
      "orchestrator.effort": "local",
      "orchestrator.max_budget_usd": "env",
      "agents.coder.cli": "project",
      "agents.coder.model": "local",
      "settings.concurrency": "flags",
      "context.include": "local",
    });
    expect(config.source).toContain("yxu.yaml + yxu.local.yaml");
  });

  test("changing an agent's cli replaces the whole agent", () => {
    project();
    local("agents:\n  coder: { cli: opencode, model: opencode/x }\n");
    const { config } = load();
    expect(config.agents.coder).toEqual({ cli: "opencode", model: "opencode/x" }); // no stale timeout
  });

  test("null removes what a lower layer defined", () => {
    project(TEAM.replace("  resolver: reviewer\n", ""));
    local("agents:\n  reviewer: null\n");
    const { config } = load();
    expect(config.agents.reviewer).toBeUndefined();
    expect(Object.keys(config.origins!).some((k) => k.startsWith("agents.reviewer"))).toBe(false);
  });

  test("errors name the file that set the bad value", () => {
    project();
    local("agents:\n  coder: { cli: cursor }\n");
    expect(() => load()).toThrow(/invalid config yxu\.local\.yaml: agent "coder": unknown cli "cursor"/);
    local("settings: { resolver: ghost }\n");
    expect(() => load()).toThrow(/invalid config yxu\.local\.yaml: settings\.resolver "ghost"/);
  });

  test("versions: newer files are refused, bad versions explained", () => {
    project(`version: 2\n${TEAM}`);
    expect(() => load()).toThrow(/version 2.*yxu update/);
    project(`version: one\n${TEAM}`);
    expect(() => load()).toThrow(/version must be a whole number/);
    project(`version: 1\n${TEAM}`);
    expect(load().layers.find((l) => l.name === "project")?.version).toBe(1);
  });

  test("yxu.yml is accepted for the project layer", () => {
    writeFileSync(join(root, "yxu.yml"), TEAM);
    expect(load().config.agents.reviewer?.model).toBe("sonnet");
  });

  test("env and --set parsing", () => {
    expect(envLayer({ YXU_ORCHESTRATOR_MODEL: "haiku", YXU_SETTINGS_CONCURRENCY: "4", YXU_CONTEXT_MEMORY: "false", YXU_ASCII: "1", YXU_CLAUDE_PATH: "/x" })).toEqual({
      orchestrator: { model: "haiku" },
      settings: { concurrency: 4 },
      context: { memory: false },
    });
    expect(setsLayer(["agents.coder.model=opencode/a:b", "context.include=[a.md, b.md]", "agents.x=null"])).toEqual({
      agents: { coder: { model: "opencode/a:b" }, x: null },
      context: { include: ["a.md", "b.md"] },
    });
    expect(() => setsLayer(["novalue"])).toThrow(/key=value/);
  });
});

describe("editing layers", () => {
  test("saving to local creates a git-ignored yxu.local.yaml and validates the merge first", () => {
    project();
    const file = saveConfigPatch(root, [{ path: ["agents", "coder", "model"], value: "deepseek/deepseek-v4-pro" }], "local");
    expect(file).toBe(join(root, "yxu.local.yaml"));
    const text = readFileSync(file, "utf8");
    expect(text).toContain("version: 1");
    expect(parseYaml(text).agents).toEqual({ coder: { model: "deepseek/deepseek-v4-pro" } });
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8").split("\n")).toContain("yxu.local.yaml");
    expect(git(root, "status", "--porcelain")).not.toContain("yxu.local.yaml");
    expect(readFileSync(join(root, "yxu.yaml"), "utf8")).toBe(TEAM); // team file untouched

    expect(() => saveConfigPatch(root, [{ path: ["agents", "coder", "cli"], value: "cursor" }], "local")).toThrow(/unknown cli "cursor"/);
    expect(readFileSync(file, "utf8")).toBe(text); // nothing written
  });

  test("saving to user creates ~/.config/yxu/config.yaml", () => {
    project();
    const file = saveConfigPatch(root, [{ path: ["orchestrator", "model"], value: "sonnet" }], "user");
    expect(file).toBe(join(home, "yxu", "config.yaml"));
    expect(load().config.orchestrator.model).toBe("sonnet");
  });

  test("a new project file starts from the starter config only while no layer has agents", () => {
    saveConfigPatch(root, [{ path: ["settings", "concurrency"], value: 2 }], "project");
    expect(readFileSync(join(root, "yxu.yaml"), "utf8")).toContain("heavy-coder");
    rmSync(join(root, "yxu.yaml"));
    user("agents:\n  mine: { cli: opencode }\n");
    saveConfigPatch(root, [{ path: ["settings", "concurrency"], value: 2 }], "project");
    expect(readFileSync(join(root, "yxu.yaml"), "utf8")).not.toContain("heavy-coder");
  });

  test("migrate adds version: 1 below the header comment, once", () => {
    const m = migrateText("# team config\nagents:\n  a: { cli: claude } # keep\n");
    expect(m).toMatchObject({ from: 0, to: 1 });
    expect(m.after).toBe("# team config\n\nversion: 1\nagents:\n  a: { cli: claude } # keep\n");
    expect(migrateText(m.after).after).toBe(m.after);
    expect(() => migrateText("version: 9\n")).toThrow(/newer/);
  });
});

describe("explain", () => {
  test("every leaf with the file it came from; written values, not parsed ones", () => {
    project();
    local("agents:\n  coder: { model: deepseek/deepseek-v4-pro }\n");
    const loaded = load(["compact.warn_at=0.9"]);
    const rows = explainRows(loaded, root);
    const row = (k: string) => rows.find((r) => r.key === k);
    expect(row("agents.coder.model")).toMatchObject({ value: "deepseek/deepseek-v4-pro", from: "yxu.local.yaml", layer: "local" });
    expect(row("agents.coder.timeout")).toMatchObject({ value: "15m", from: "yxu.yaml" });
    expect(row("compact.warn_at")).toMatchObject({ value: "0.9", from: "command-line flag" });
    expect(row("orchestrator.model")).toMatchObject({ value: "opus", from: "built-in default" });
    expect(explainRows(loaded, root, "agents.reviewer").map((r) => r.key)).toEqual(["agents.reviewer.cli", "agents.reviewer.model"]);
    expect(originOf(loaded, "agents.coder.model", root)).toEqual({ layer: "local", file: "yxu.local.yaml" });
  });
});

describe("JSON Schema", () => {
  test("the committed schema/yxu.schema.json is up to date (run: bun run schema)", () => {
    expect(readFileSync(join(import.meta.dir, "..", "schema", "yxu.schema.json"), "utf8")).toBe(schemaText());
  });

  test("accepts the starter config and partial layer files; rejects mistakes", () => {
    const validate = new Ajv({ strict: false, allErrors: true }).compile(configJsonSchema());
    expect(validate(parseYaml(DEFAULT_YAML))).toBe(true);
    expect(validate({ version: 1, agents: { coder: { model: "x" } }, settings: { concurrency: 5 } })).toBe(true);
    expect(validate({ agents: { reviewer: null } })).toBe(true);
    expect(validate({ agents: { coder: { cli: "Not A Cli" } } })).toBe(false);
    expect(validate({ settings: { concurrency: "lots" } })).toBe(false);
    expect(validate({ version: 2 })).toBe(false);
  });
});

describe("interface", () => {
  function app() {
    project(`version: 1\n${TEAM}`);
    git(root, "add", ".");
    git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
    local("version: 1\nsettings: { concurrency: 5 }\n");
    let rows: string[] = [];
    const a = new App({
      cfg: loadLayers(root).config,
      root,
      theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
      engine: { run: async () => ({}) as never },
      historyFile: null,
      catalog: testCatalog(),
      draw: (f) => (rows = f.rows),
      size: () => ({ width: 140, height: 50 }),
      exit: () => {},
    });
    const screen = () => {
      a.render();
      return rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    };
    return { a, screen };
  }

  test("/save local writes yxu.local.yaml and leaves the team file alone", () => {
    const { a, screen } = app();
    a.runCommand("/model sonnet");
    a.runCommand("/save local");
    expect(screen()).toContain("Saved 1 setting to yxu.local.yaml (local)");
    expect(parseYaml(readFileSync(join(root, "yxu.local.yaml"), "utf8")).orchestrator.model).toBe("sonnet");
    expect(readFileSync(join(root, "yxu.yaml"), "utf8")).not.toContain("sonnet\n  effort");
    expect(existsSync(join(root, "yxu.local.yaml"))).toBe(true);
  });

  test("/save project warns when a higher layer still overrides the value", () => {
    const { a, screen } = app();
    a.runCommand("/concurrency 2");
    a.runCommand("/save project");
    const s = screen();
    expect(s).toContain("Saved 1 setting to yxu.yaml (project)");
    expect(s).toContain("settings.concurrency is still overridden by yxu.local.yaml");
  });

  test("/config shows layers and origins; unknown layers are refused", () => {
    const { a, screen } = app();
    a.runCommand("/config settings");
    let s = screen();
    expect(s).toContain("Config layers");
    expect(s).toMatch(/settings\.concurrency.*= 5 · yxu\.local\.yaml/);
    a.runCommand("/save team");
    s = screen();
    expect(s).toContain('unknown layer "team"');
  });
});

describe("interface palette", () => {
  test("/config completes sections, so enter on a typed section keeps it", () => {
    project();
    local("agents:\n  coder: { model: deepseek/deepseek-v4-pro }\n");
    const cfg = loadLayers(root).config;
    const a = new App({
      cfg, root, theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
      engine: { run: async () => ({}) as never }, historyFile: null, catalog: testCatalog(),
      draw: () => {}, size: () => ({ width: 120, height: 40 }), exit: () => {},
    });
    const items = paletteFor(a, "/config agents.coder")!.items.map((i) => i.value);
    expect(items[0]).toBe("agents.coder");
    expect(items).toContain("agents.coder.model");
  });
});
