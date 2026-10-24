import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_YAML, parseConfig } from "../src/config.ts";
import { buildKeymap, normalizeSpec, translateKey } from "../src/keymap.ts";
import { App } from "../src/tui/app.ts";
import { createTheme, nearest256 } from "../src/tui/theme.ts";
import { BUILTIN_THEMES, loadTheme } from "../src/tui/themes.ts";
import type { Frame } from "../src/tui/view.ts";
import { testCatalog } from "./helpers.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const always = { moment: "always" as const, draftEmpty: true };

describe("keymap", () => {
  test("specs normalize; unknown actions, keys and clashes are errors", () => {
    expect(normalizeSpec("Ctrl+P")).toBe("ctrl+p");
    expect(normalizeSpec("shift+ctrl+PgUp")).toBe("ctrl+shift+pageup");
    expect(normalizeSpec("esc")).toBe("escape");
    expect(() => normalizeSpec("hyper+x")).toThrow(/modifier/);
    expect(() => normalizeSpec("ctrl+banana")).toThrow(/unknown key/);
    expect(() => buildKeymap({ fly: "x" })).toThrow(/unknown action "fly"/);
    expect(() => buildKeymap({ panel: "ctrl+o" })).toThrow(/"ctrl\+o" is bound to both/);
    // decision and gate keys live in different moments, so they may share letters
    expect(() => buildKeymap({ approve: "a" })).not.toThrow();
    expect(buildKeymap({ panel: "ctrl+a" }).warnings[0]).toMatch(/message editor/);
  });

  test("a rebound action answers to the new key only; letters never hijack typing", () => {
    const km = buildKeymap({ panel: "ctrl+b", help: "h", apply: "y" });
    expect(translateKey({ name: "char", text: "b", ctrl: true }, km, always)).toEqual({ name: "char", text: "p", ctrl: true });
    expect(translateKey({ name: "char", text: "p", ctrl: true }, km, always)).toBeNull();
    // "h" opens help on an empty draft, but types an h inside a message
    expect(translateKey({ name: "char", text: "h" }, km, always)).toEqual({ name: "char", text: "?" });
    expect(translateKey({ name: "char", text: "h" }, km, { moment: "always", draftEmpty: false })).toEqual({ name: "char", text: "h" });
    // the freed "?" just types
    expect(translateKey({ name: "char", text: "?" }, km, always)).toEqual({ name: "paste", text: "?" });
    // decision keys apply only while deciding
    expect(translateKey({ name: "char", text: "y" }, km, { moment: "decision", draftEmpty: true })).toEqual({ name: "char", text: "a" });
    expect(translateKey({ name: "char", text: "y" }, km, { moment: "gate", draftEmpty: true })).toEqual({ name: "char", text: "y" });
  });

  test("ui.keys is validated with the rest of the config", () => {
    expect(() => parseConfig("agents: { a: { cli: claude } }\nui: { keys: { panel: ctrl+o } }\n", "x")).toThrow(/ui\.keys.*bound to both/);
  });
});

describe("themes", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yxu-theme-"));
    process.env.XDG_CONFIG_HOME = home;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("built-ins exist and differ; 256-color fallbacks are derived", () => {
    expect(Object.keys(BUILTIN_THEMES)).toEqual(["instrument", "high-contrast", "light", "mono"]);
    expect(nearest256([0, 0, 0])).toBe(16);
    expect(nearest256([255, 255, 255])).toBe(231);
    expect(nearest256([128, 128, 128])).toBe(244);
    const dark = createTheme({ depth: "truecolor", palette: loadTheme("instrument").palette }).sgr({ fg: "ivory" });
    const light = createTheme({ depth: "truecolor", palette: loadTheme("light").palette }).sgr({ fg: "ivory" });
    expect(dark).not.toBe(light);
    expect(createTheme({ depth: "16", palette: loadTheme("light").palette }).sgr({ fg: "ivory" })).toContain("30");
  });

  test("theme files extend a base, override colors and glyphs, and report mistakes", () => {
    mkdirSync(join(home, "yxu", "themes"), { recursive: true });
    writeFileSync(join(home, "yxu", "themes", "sol.yaml"), "extends: light\ncolors: { cyan: '#2aa198' }\nglyphs: { mark: '◆' }\n");
    const t = loadTheme("sol");
    expect(t.palette.rgb.cyan).toEqual([42, 161, 152]);
    expect(t.palette.rgb.bg).toEqual(BUILTIN_THEMES.light!.palette.rgb.bg);
    expect(createTheme({ ...t, depth: "truecolor", ascii: false }).glyphs.mark).toBe("◆");
    writeFileSync(join(home, "yxu", "themes", "bad.yaml"), "colors: { cyan: blue }\n");
    expect(() => loadTheme("bad")).toThrow(/colors\.cyan: colors are #rrggbb/);
    writeFileSync(join(home, "yxu", "themes", "loop.yaml"), "extends: loop\n");
    expect(() => loadTheme("loop")).toThrow(/extends itself/);
    expect(() => loadTheme("nope")).toThrow(/unknown theme "nope".*yours: bad, loop, sol/);
  });
});

describe("layout and interface", () => {
  function app(ui: string) {
    let frame: Frame = { rows: [] };
    const a = new App({
      cfg: parseConfig(`${DEFAULT_YAML}\nui:\n${ui}`, "test"),
      root: "/repo-does-not-exist",
      theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
      engine: { run: async () => ({}) as never },
      historyFile: null,
      catalog: testCatalog(),
      draw: (f) => (frame = f),
      size: () => ({ width: 130, height: 40 }),
      exit: () => {},
    });
    const screen = () => {
      a.render();
      return strip(frame.rows.join("\n"));
    };
    return { a, screen, rows: () => frame.rows.length };
  }

  test("panel sections follow ui.panel_sections; the footer can be hidden", () => {
    const { screen, rows } = app("  panel_sections: [cost, tasks]\n  footer: false\n");
    const s = screen();
    expect(s.indexOf("C O S T")).toBeLessThan(s.indexOf("T A S K S"));
    expect(s).not.toContain("C O N T E X T");
    expect(s).not.toContain("enter send");
    expect(rows()).toBe(40); // the frame still fills the terminal
  });

  test("ui.panel: false starts with the panel closed; rebound keys work", () => {
    const { a, screen } = app("  panel: false\n  keys: { panel: ctrl+b }\n");
    expect(screen()).not.toContain("C O N T E X T");
    a.input("\x10"); // ctrl+p no longer toggles
    expect(screen()).not.toContain("C O N T E X T");
    a.input("\x02"); // ctrl+b does
    expect(screen()).toContain("C O N T E X T");
  });

  test("/theme switches live and is saved like any setting; /keys lists bindings", () => {
    const { a, screen } = app("  theme: instrument\n");
    a.runCommand("/theme light");
    expect(a.theme.name).toBe("light");
    expect(screen()).toContain("Theme light");
    expect(a.cfg.ui.theme).toBe("light");
    a.runCommand("/theme nope");
    expect(screen()).toContain('unknown theme "nope"');
    a.runCommand("/keys");
    expect(screen()).toMatch(/ctrl\+p panel/);
  });
});
