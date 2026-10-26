import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { parseConfig } from "../src/config.ts";
import type { RunOutcome } from "../src/orchestrator/run.ts";
import { App } from "../src/tui/app.ts";
import { KeyParser } from "../src/tui/keys.ts";
import { Terminal } from "../src/tui/terminal.ts";
import { createTheme } from "../src/tui/theme.ts";
import { testCatalog } from "./helpers.ts";

describe("mouse wheel", () => {
  test("SGR wheel reports become wheel keys; clicks and sideways scrolling are swallowed, never typed", () => {
    const p = new KeyParser();
    expect(p.feed("\x1b[<64;10;5M")).toEqual([{ name: "wheelup" }]);
    expect(p.feed("\x1b[<65;10;5M")).toEqual([{ name: "wheeldown" }]);
    expect(p.feed("\x1b[<68;1;1M")).toEqual([{ name: "wheelup", shift: true }]);
    expect(p.feed("\x1b[<0;3;4M\x1b[<0;3;4m").map((k) => k.name)).toEqual(["mouse", "mouse"]); // click
    expect(p.feed("\x1b[<66;1;1M").map((k) => k.name)).toEqual(["mouse"]); // horizontal
    // Split across reads, and followed by typing.
    expect(p.feed("\x1b[<6")).toEqual([]);
    expect(p.feed("5;120;40Mab").map((k) => k.name + (k.text ?? ""))).toEqual(["wheeldown", "chara", "charb"]);
  });

  test("the terminal turns wheel reporting on and off (or, with ui.mouse false, stops wheel-as-arrows)", () => {
    const run = (mouse?: boolean) => {
      let out = "";
      const fakeOut = Object.assign(new EventEmitter(), { write: (s: string) => ((out += s), true), columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream;
      const fakeIn = Object.assign(new EventEmitter(), { isTTY: false, setEncoding() {}, resume() {}, pause() {} }) as unknown as NodeJS.ReadStream;
      const t = new Terminal(fakeOut, fakeIn);
      t.start({ data: () => {}, resize: () => {} }, mouse === undefined ? {} : { mouse });
      const started = out;
      t.stop();
      return { started, stopped: out.slice(started.length) };
    };
    const on = run();
    expect(on.started).toContain("\x1b[?1000h\x1b[?1006h");
    expect(on.stopped).toContain("\x1b[?1006l\x1b[?1000l");
    const off = run(false);
    expect(off.started).toContain("\x1b[?1007l");
    expect(off.started).not.toContain("?1000h");
    expect(off.stopped).toContain("\x1b[?1007h");
  });

  test("in the interface the wheel scrolls the conversation, the help and the palette, never the message or its history", () => {
    const app = new App({
      cfg: parseConfig("agents:\n  coder: { cli: opencode }\n", "/tmp/x/yxu.yaml"),
      root: "/repo-does-not-exist",
      theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
      engine: { run: async ({ session }) => ({ runId: "r", ok: true, finalText: "", costUsd: 0, session }) as RunOutcome },
      historyFile: null,
      catalog: testCatalog(),
      draw: () => {},
      size: () => ({ width: 120, height: 20 }),
      exit: () => {},
    });
    for (let i = 0; i < 40; i++) app.store.add({ kind: "notice", tone: "info", text: `line ${i}` });
    app.input("first goal draft");
    app.input("\x1b[<64;5;5M\x1b[<64;5;5M");
    expect(app.store.state.scroll).toBe(6);
    expect(app.editor.text).toBe("first goal draft"); // untouched
    app.input("\x1b[<65;5;5M");
    expect(app.store.state.scroll).toBe(3);
    app.input("\x1b[<68;5;5M"); // shift: a page
    expect(app.store.state.scroll).toBeGreaterThan(10);
    app.input("\x1b[<0;5;5M\x1b[<0;5;5m"); // a click types nothing
    expect(app.editor.text).toBe("first goal draft");

    // Help: the wheel scrolls it.
    app.input("\x15"); // ctrl+u clears the draft
    app.input("?");
    expect(app.store.state.helpOpen).toBe(true);
    app.input("\x1b[<65;5;5M");
    expect(app.store.state.helpScroll).toBe(3);
    app.input("?"); // closes help
    expect(app.store.state.helpOpen).toBe(false);
    // Palette: the wheel moves the selection.
    app.input("/co");
    const before = app.store.state.palette!.selected;
    app.input("\x1b[<65;5;5M");
    expect(app.store.state.palette!.selected).toBe(before + 1);
    app.dispose();
  });
});
