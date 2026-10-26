/**
 * Render interface scenes to an HTML page, in the real colors, for design work and screenshots:
 *   bun scripts/tui-snapshot.ts [out.html] [--width 160] [--height 44]
 * Scenes: the welcome screen (with saved sessions), a run in progress, a decision.
 * Uses the real renderer (renderFrame) on states set up directly; nothing runs.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_YAML, parseConfig } from "../src/config.ts";
import { Conversation } from "../src/conversation.ts";
import { git, YXU_IDENTITY } from "../src/git.ts";
import type { RunOutcome } from "../src/orchestrator/run.ts";
import { newSession, saveSession } from "../src/sessions.ts";
import { App, type Engine } from "../src/tui/app.ts";
import { createTheme } from "../src/tui/theme.ts";
import type { Frame } from "../src/tui/view.ts";
import { emptyUsage } from "../src/types.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { width: { type: "string" }, height: { type: "string" } } });
const W = Number(values.width ?? 160);
const H = Number(values.height ?? 44);
const out = positionals[0] ?? join(tmpdir(), "yxu-tui-snapshot.html");

// A scratch repository named like a real project, and a private session store.
const base = mkdtempSync(join(tmpdir(), "yxu-snap-"));
const root = join(base, "enova-chat");
mkdirSync(root);
git(root, "init", "-q", "-b", "main-dev");
writeFileSync(join(root, "README.md"), "# enova-chat\n");
git(root, "add", ".");
git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
process.env.YXU_DATA_DIR = join(base, "data");
process.env.XDG_CONFIG_HOME = join(base, "config");

for (const [title, turns, ago] of [["Fix the login redirect loop", 3, 2], ["Add rate limiting to the chat API", 5, 26], ["Docs for the settings page", 1, 80]] as const) {
  const c = new Conversation();
  for (let i = 0; i < turns; i++) c.finish({ goal: `${title} ${i}`, finalText: "ok", sessionId: "x", usedSummary: false });
  const s = newSession(root, root, c.state);
  s.title = title;
  saveSession(s);
  // Backdate it.
  const file = join(process.env.YXU_DATA_DIR, "sessions", `${s.id}.json`);
  const j = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
  j.updatedAt = new Date(Date.now() - ago * 3600_000).toISOString();
  writeFileSync(file, JSON.stringify(j));
}

const engine: Engine = { run: async ({ session }) => ({ runId: "r", ok: true, finalText: "", costUsd: 0, session }) as RunOutcome };
function scene(setup: (app: App) => void): Frame {
  let frame: Frame = { rows: [] };
  const app = new App({
    cfg: parseConfig(DEFAULT_YAML, join(root, "yxu.yaml")),
    root,
    theme: createTheme({ depth: "truecolor", ascii: false, reducedMotion: true }),
    engine,
    historyFile: null,
    draw: (f) => (frame = f),
    size: () => ({ width: W, height: H }),
    exit: () => {},
  });
  setup(app);
  app.render();
  app.dispose();
  return frame;
}

const task = (id: string, agent: string, files: string[]) => ({
  taskId: id, agent, ok: true, summary: "done", usage: emptyUsage(), exitCode: 0, durationMs: 41_000, diff: "+x", filesChanged: files, branch: `yxu/${id}`,
});

const scenes: [string, Frame][] = [
  ["Welcome", scene(() => {})],
  [
    "A run in progress",
    scene((app) => {
      const s = app.store;
      s.set({ turn: 1, remembering: true, activeSlots: 2, cost: { orchestrator: 0.4299, subagents: 0.0312 }, usage: { tokens: 25_000, max: 1_000_000, percentage: 2.5, autoCompact: true, threshold: 967_000, categories: [] } });
      s.add({ kind: "user", text: "Add rate limiting to the chat API: 20 messages a minute per user, with a clear error.", time: new Date() });
      s.add({ kind: "assistant", text: "I'll map the request path first, then split the work:\n\n1. **builder** adds a token-bucket limiter in `lib/rate-limit.ts` and wires it into `app/api/chat/route.ts`.\n2. **tester** covers the limit, the reset and the error response.", streaming: false });
      s.add({ kind: "activity", category: "read", title: "read\tapp/api/chat/route.ts, lib/redis.ts", meta: "2 lookups", state: "ok", details: [], expanded: false, startedAt: Date.now() - 60_000 });
      s.add({ kind: "activity", category: "tool", title: "builder\tAdd a token-bucket limiter and wire it into the chat route", meta: "edit lib/rate-limit.ts", state: "running", details: [], expanded: false, startedAt: Date.now() - 74_000 });
      s.add({ kind: "activity", category: "tool", title: "tester\tCover the limit, the reset and the 429 response", meta: "bash bun test", state: "running", details: [], expanded: false, startedAt: Date.now() - 31_000 });
      s.upsertTask({ taskId: "20261026-a1b2", agent: "builder", state: "running", title: "limiter", files: 0, pending: false });
      s.upsertTask({ taskId: "20261026-c3d4", agent: "tester", state: "running", title: "tests", files: 0, pending: false });
      s.upsertTask({ taskId: "20261026-e5f6", agent: "scout", state: "ok", title: "map", files: 0, pending: false });
      s.setStatus("working", "2 agents at work");
      s.set({ since: Date.now() - 95_000 });
    }),
  ],
  [
    "A result to decide on",
    scene((app) => {
      const s = app.store;
      s.set({ turn: 1, remembering: true, cost: { orchestrator: 0.61, subagents: 0.05 } });
      s.add({ kind: "user", text: "Add rate limiting to the chat API: 20 messages a minute per user, with a clear error.", time: new Date() });
      s.add({ kind: "activity", category: "tool", title: "builder\tAdd a token-bucket limiter and wire it into the chat route", meta: "41s · 3 files", state: "ok", details: [], expanded: false, startedAt: Date.now() });
      s.add({ kind: "activity", category: "tool", title: "verify\tbun test", meta: "passed 6.2s", state: "ok", details: [], expanded: false, startedAt: Date.now() });
      s.add({ kind: "assistant", text: "Done. `builder` added the limiter (20 per minute per user, Redis-backed) and the route returns **429** with a `Retry-After` header. `tester` added 6 tests; `bun test` passes.\n\nApply task `20261026-a1b2` to bring it into `main-dev`.", streaming: false });
      app.taskSession.tasks.set("20261026-a1b2", { ...task("20261026-a1b2", "builder", ["lib/rate-limit.ts", "app/api/chat/route.ts", "lib/rate-limit.test.ts"]), prompt: "p", parents: [] });
      s.upsertTask({ taskId: "20261026-a1b2", agent: "builder", state: "ok", title: "limiter", files: 3, pending: true });
      s.set({ decision: { taskId: "20261026-a1b2", agent: "builder", stat: { files: 3, added: 96, removed: 4 }, includes: 1, others: [] } });
      s.setStatus("deciding", "a result is ready for review");
    }),
  ],
];

// ── ANSI → HTML ───────────────────────────────────────────────────────────
function toHtml(rows: string[]): string {
  let html = "";
  for (const row of rows) {
    let fg = "", bg = "", bold = false, italic = false, underline = false;
    let line = "";
    const parts = row.split(/(\x1b\[[0-9;]*m)/);
    for (const p of parts) {
      const m = /^\x1b\[([0-9;]*)m$/.exec(p);
      if (m) {
        const codes = (m[1] || "0").split(";").map(Number);
        for (let i = 0; i < codes.length; i++) {
          const c = codes[i]!;
          if (c === 0) [fg, bg, bold, italic, underline] = ["", "", false, false, false];
          else if (c === 1) bold = true;
          else if (c === 22) bold = false;
          else if (c === 3) italic = true;
          else if (c === 4) underline = true;
          else if (c === 39) fg = "";
          else if (c === 49) bg = "";
          else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
            const rgb = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
            if (c === 38) fg = rgb;
            else bg = rgb;
            i += 4;
          }
        }
        continue;
      }
      if (!p) continue;
      const text = p.replace(/[\x00-\x1f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
      line += `<span style="${fg ? `color:${fg};` : ""}${bg ? `background:${bg};` : ""}${bold ? "font-weight:700;" : ""}${italic ? "font-style:italic;" : ""}${underline ? "text-decoration:underline;" : ""}">${text}</span>`;
    }
    html += `<div class="r">${line || " "}</div>`;
  }
  return html;
}

const page = `<!doctype html><meta charset="utf-8"><title>yxu interface</title>
<style>
body{background:#05070a;margin:0;padding:24px;font-family:"JetBrains Mono","Iosevka","DejaVu Sans Mono",monospace;font-size:13px;color:#ccc}
h2{font:600 14px system-ui;color:#9a9;margin:18px 0 8px}
.t{display:inline-block;background:rgb(11,13,17);padding:6px 8px;border-radius:8px;box-shadow:0 0 0 1px #1c2028}
.r{white-space:pre;line-height:1.32;height:1.32em}
</style>
${scenes.map(([name, f]) => `<h2>${name}</h2><div class="t">${toHtml(f.rows)}</div>`).join("\n")}`;
writeFileSync(out, page);
console.log(out);
