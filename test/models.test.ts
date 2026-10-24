import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { CLAUDE_MODELS, ModelCatalog, parseCommandCodeModels, parseOpencodeModels, type ModelInfo } from "../src/models.ts";
import { App, type Engine } from "../src/tui/app.ts";
import { paletteFor } from "../src/tui/commands.ts";
import { createTheme } from "../src/tui/theme.ts";
import type { Frame } from "../src/tui/view.ts";
import { testCatalog } from "./helpers.ts";

const fixture = (n: string) => readFileSync(join(import.meta.dir, "fixtures", n), "utf8");
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

describe("parsers (real CLI output)", () => {
  test("Command Code: 93 models in sections, default marked, help text ignored", () => {
    const ms = parseCommandCodeModels(fixture("commandcode-models.txt"));
    expect(ms).toHaveLength(93); // the CLI's own header says "93 models"
    expect([...new Set(ms.map((m) => m.group))]).toEqual(["Open Source", "Stealth", "Anthropic", "OpenAI", "Google", "Sakana", "Meta", "xAI"]);
    expect(ms.find((m) => m.isDefault)).toMatchObject({ id: "deepseek/deepseek-v4-flash", description: "fast hybrid-attention reasoning" });
    expect(ms.some((m) => m.id.startsWith("cmd") || m.id === "typesafe/jev")).toBe(false);
  });

  test("OpenCode verbose: provider groups, name, context, price; deprecated skipped", () => {
    const ms = parseOpencodeModels(fixture("opencode-models-verbose.txt"));
    // The fixture's azure/claude-fable-5 is marked deprecated, so it is skipped.
    expect(ms.map((m) => m.id)).toEqual(["opencode/beam-free", "opencode/big-pickle", "amazon-bedrock/amazon.nova-2-lite-v1:0", "amazon-bedrock/amazon.nova-lite-v1:0", "azure/claude-fable-5-1"]);
    expect(ms[0]).toEqual({ id: "opencode/beam-free", group: "opencode", description: "Beam Free · 1049k ctx · free" });
    expect(ms[2]!.description).toMatch(/\$[\d.]+\/\$[\d.]+ per M/);
    const dep = `x/old\n{"name":"Old","status":"deprecated"}\nx/new\n{"name":"New","status":"active","cost":{"input":0,"output":0}}\n`;
    expect(parseOpencodeModels(dep)).toEqual([{ id: "x/new", group: "x", description: "New · price not listed" }]);
  });

  test("OpenCode plain output (ids only) still parses", () => {
    expect(parseOpencodeModels("a/one\nb/two\n").map((m) => m.id)).toEqual(["a/one", "b/two"]);
  });
});

describe("ModelCatalog", () => {
  test("loads in the background, caches to disk, and serves the cache next time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yxu-models-"));
    const path = join(dir, "models.json");
    let calls = 0;
    const discover = async (): Promise<ModelInfo[]> => {
      calls++;
      return [{ id: "p/m1", group: "p", description: "one" }];
    };
    const a = new ModelCatalog(path, discover);
    expect(a.get("opencode").status).toBe("loading");
    await a.refresh("opencode");
    expect(a.get("opencode")).toMatchObject({ status: "ready", models: [{ id: "p/m1" }] });
    const b = new ModelCatalog(path, discover);
    expect(b.get("opencode").models.map((m) => m.id)).toEqual(["p/m1"]); // from disk, no new call
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8")).opencode.models).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("stale cache refreshes; errors keep old models and are reported", async () => {
    let fail = false;
    const c = new ModelCatalog(null, async () => {
      if (fail) throw new Error("opencode: not logged in");
      return [{ id: "p/a", group: "p", description: "" }];
    }, 0);
    await c.refresh("opencode");
    fail = true;
    await c.refresh("opencode");
    expect(c.get("opencode")).toMatchObject({ status: "error", error: "opencode: not logged in", models: [{ id: "p/a" }] });
  });

  test("claude is static and immediate", () => {
    expect(new ModelCatalog(null, async () => { throw new Error("never called"); }).get("claude")).toMatchObject({ status: "ready", models: CLAUDE_MODELS });
  });
});

function app(catalog = testCatalog()) {
  let frame: Frame = { rows: [] };
  const engine: Engine = { run: async ({ session }) => ({ runId: "r", ok: true, finalText: "", costUsd: 0, session }) };
  const a = new App({
    cfg: parseConfig("agents:\n  coder: { cli: commandcode, model: deepseek/deepseek-v4-flash }\n  oc: { cli: opencode }\n", "/nope/yxu.yaml"),
    root: "/nope",
    theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
    engine,
    historyFile: null,
    catalog,
    draw: (f) => (frame = f),
    size: () => ({ width: 130, height: 40 }),
    exit: () => {},
  });
  return { a, screen: () => (a.render(), strip(frame.rows.join("\n"))) };
}

describe("model selection in the palette", () => {
  test("/agent <name> model lists that CLI's models, current first, searchable", async () => {
    const { a, screen } = app();
    a.catalog.get("commandcode");
    await a.catalog.refresh("commandcode");
    const p = paletteFor(a, "/agent coder model ")!;
    expect(p.items).toHaveLength(93);
    expect(p.items[0]).toMatchObject({ value: "deepseek/deepseek-v4-flash" });
    expect(p.items[0]!.description).toMatch(/^current · Open Source/);
    expect(p.status).toBe("93 commandcode models · type to search ids and descriptions");
    // search by id fragment and by description
    expect(paletteFor(a, "/agent coder model kimi")!.items.every((i) => i.value.includes("kimi"))).toBe(true);
    expect(paletteFor(a, "/agent coder model vision")!.items.map((i) => i.value)).toContain("deepseek/deepseek-v4.1-flash");
    a.input("/agent coder model kimi-k3\r");
    expect(a.cfg.agents.coder!.model).toBe("moonshotai/kimi-k3"); // enter picked the best match
    expect(screen()).toContain("coder now uses moonshotai/kimi-k3");
    a.dispose();
  });

  test("opencode agent gets opencode's models; free ones are findable", async () => {
    const { a } = app();
    await a.catalog.refresh("opencode");
    const ids = paletteFor(a, "/agent oc model free")!.items.map((i) => i.value);
    expect(ids).toEqual(["opencode/beam-free", "opencode/big-pickle"]); // OpenCode's free tier only
    a.dispose();
  });

  test("while loading, the palette says so; it fills in when the list arrives", async () => {
    let release!: () => void;
    const slow = new ModelCatalog(null, () => new Promise((r) => (release = () => r([{ id: "p/late", group: "p", description: "" }]))));
    const { a, screen } = app(slow);
    a.input("/agent oc model ");
    expect(screen()).toContain("loading models from opencode…");
    release();
    await Bun.sleep(5);
    expect(screen()).toContain("p/late");
    a.dispose();
  });

  test("unknown model is allowed (short names exist) but flagged", async () => {
    const { a, screen } = app();
    await a.catalog.refresh("commandcode");
    a.runCommand("/agent coder model not-a-model");
    expect(a.cfg.agents.coder!.model).toBe("not-a-model");
    expect(screen()).toContain("not-a-model is not in the 93 models commandcode reported");
    a.dispose();
  });

  test("/models overview and per-CLI search; /model uses Claude's models", async () => {
    const { a, screen } = app();
    await Promise.all([a.catalog.refresh("commandcode"), a.catalog.refresh("opencode")]);
    await a.showModels([]);
    let s = screen();
    expect(s).toContain("commandcode — 93 models (Open Source, Stealth, Anthropic");
    expect(s).toContain("used by coder");
    await a.showModels(["coder", "gemini"]);
    s = screen();
    expect(s).toMatch(/commandcode — \d+ of 93 models matching "gemini"/);
    expect(s).toContain("google/gemini-4-argon");
    expect(paletteFor(a, "/model ")!.items.map((i) => i.value).slice(0, 4)).toEqual(["opus", "sonnet", "haiku", "fable"]);
    a.dispose();
  });
});
