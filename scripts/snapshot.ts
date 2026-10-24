/**
 * Render TUI frames headlessly (demo engine) for visual review.
 *   bun scripts/snapshot.ts [--width 140] [--height 44] [--ascii] [--reduced-motion] [--html out.html] [--at working|deciding|help|welcome|fault]
 * Prints the frame as plain text; with --html also writes a styled HTML page of the ANSI frame.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseConfig, DEFAULT_YAML } from "../src/config.ts";
import { App, type Engine } from "../src/tui/app.ts";
import { demoBackend, demoEngine } from "../src/tui/demo.ts";
import { createTheme } from "../src/tui/theme.ts";
import type { Frame } from "../src/tui/view.ts";

const { values } = parseArgs({
  options: {
    width: { type: "string", default: "140" },
    height: { type: "string", default: "44" },
    ascii: { type: "boolean" },
    "reduced-motion": { type: "boolean" },
    html: { type: "string" },
    at: { type: "string", default: "deciding" },
    panel: { type: "string", default: "open" },
  },
});
const width = Number(values.width);
const height = Number(values.height);
const theme = createTheme({ depth: "truecolor", ascii: values.ascii ?? false, reducedMotion: values["reduced-motion"] ?? false });
const cfg = parseConfig(DEFAULT_YAML, "yxu.yaml");
let frame: Frame = { rows: [] };
let app: App;
const failing: Engine = {
  async run({ session }) {
    return { runId: "x", ok: false, finalText: "Error: You've reached your weekly usage limit. Resets in 2d 5h.", costUsd: 0.0123, session };
  },
};
app = new App({
  cfg, root: process.cwd(), theme, demo: true,
  engine: values.at === "fault" ? failing : demoEngine(values.at === "working" ? 1 : 50),
  backend: demoBackend(() => app.taskSession),
  historyFile: null,
  draw: (f) => (frame = f),
  size: () => ({ width, height }),
  exit: () => {},
});
if (values.panel === "closed") app.store.set({ panelOpen: false });
const type = (s: string) => app.input(s);
if (values.at !== "welcome") {
  type("Add a history feature: log each calculation and add a `history` subcommand");
  if (values.at === "help") type("");
  type("\r");
  if (values.at === "working") await Bun.sleep(3200);
  else await app.idle();
  if (values.at === "deciding") {
    app.key({ name: "up", ctrl: true });
    app.key({ name: "up", ctrl: true });
    app.key({ name: "char", text: "o", ctrl: true });
  }
  if (values.at === "help") app.store.set({ helpOpen: true });
  if (values.at === "palette" || values.at === "palette-arg") {
    app.input("l");
    app.input("/clear\r");
    if (values.at === "palette") app.input("/");
    else app.input("/agent coder per");
  }
  if (values.at === "context") {
    app.input("l"); // decide later
    app.input("/clear\r");
    app.input("/context add README.md\r");
    app.input("/compact window 200k\r");
    app.input("/compact\r");
    await Bun.sleep(150);
    app.input("/context\r");
  }
}
await Bun.sleep(40);
app.render();
app.dispose();

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
console.log(frame.rows.map(strip).join("\n"));

if (values.html) {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const toHtml = (row: string) => {
    let out = "";
    let style: Record<string, string> = {};
    for (const part of row.split(/(\x1b\[[0-9;]*m)/)) {
      const m = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (m) {
        const codes = m[1]!.split(";").map(Number);
        for (let i = 0; i < codes.length; i++) {
          const c = codes[i]!;
          if (c === 0) style = {};
          else if (c === 1) style["font-weight"] = "700";
          else if (c === 7) style["filter"] = "invert(1)";
          else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
            style[c === 38 ? "color" : "background"] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
            i += 4;
          }
        }
        continue;
      }
      if (!part) continue;
      const css = Object.entries(style).map(([k, v]) => `${k}:${v}`).join(";");
      // Browsers don't snap glyphs to a cell grid like terminals do: box each non-ASCII char.
      let inner = "";
      for (const ch of part) {
        const w = Bun.stringWidth(ch);
        inner += ch.charCodeAt(0) < 128 ? esc(ch) : `<span class="c" style="width:${w}ch">${esc(ch)}</span>`;
      }
      out += `<span style="${css}">${inner}</span>`;
    }
    return out;
  };
  const cursor = frame.cursor;
  const html = `<!doctype html><meta charset="utf-8"><title>yxu tui</title>
<style>body{margin:0;background:#0b0d11;display:flex;justify-content:center;padding:24px}
pre{margin:0;font:14px/1.32 "JetBrains Mono","DejaVu Sans Mono",Menlo,monospace;background:#0b0d11;white-space:pre}
.c{display:inline-block;text-align:center;overflow:visible}</style>
<pre>${frame.rows.map(toHtml).join("\n")}</pre>`;
  writeFileSync(values.html, html);
  void cursor;
}
