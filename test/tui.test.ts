import { describe, expect, test } from "bun:test";
import { testCatalog } from "./helpers.ts";
import { DEFAULT_YAML, parseConfig } from "../src/config.ts";
import { Session } from "../src/ops.ts";
import type { RunOutcome } from "../src/orchestrator/run.ts";
import { App, type Engine, type TaskBackend } from "../src/tui/app.ts";
import { Editor } from "../src/tui/editor.ts";
import { KeyParser } from "../src/tui/keys.ts";
import { renderMarkdown } from "../src/tui/markdown.ts";
import { Store, type ContextInfo } from "../src/tui/model.ts";
import { recoveryHint } from "../src/tui/recovery.ts";
import { lineWidth, plain, span, truncate, wrap } from "../src/tui/text.ts";
import { ASCII_GLYPHS, createTheme, detectColorDepth, UNICODE_GLYPHS, type Theme } from "../src/tui/theme.ts";
import { renderFrame, type Frame } from "../src/tui/view.ts";
import { emptyUsage, type TaskResult } from "../src/types.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const cfg = parseConfig(DEFAULT_YAML, "test");
const ctxInfo: ContextInfo = {
  root: "/repo",
  branch: "main",
  configSource: "test",
  workflow: "default",
  mode: "auto",
  model: "opus",
  agents: [{ name: "coder", cli: "opencode", model: "x/y" }],
  concurrency: 3,
  verify: "npm test",
  memory: true,
  projectInstructions: true,
  include: [],
  hasNotes: false,
  compact: { auto: true, window: "auto", warnAt: 0.8 },
};

// ── keys ─────────────────────────────────────────────────────────────────────

describe("KeyParser", () => {
  const p = () => new KeyParser();
  test("printable, enter, newline variants", () => {
    expect(p().feed("a\r")).toEqual([{ name: "char", text: "a" }, { name: "enter" }]);
    expect(p().feed("\n")).toEqual([{ name: "newline" }]);
    expect(p().feed("\x1b\r")).toEqual([{ name: "newline", alt: true }]);
    expect(p().feed("\x1b[13;2u")).toEqual([{ name: "newline" }]); // kitty shift+enter
  });
  test("arrows with modifiers, paging, delete", () => {
    expect(p().feed("\x1b[A\x1b[1;5A\x1b[1;2B")).toEqual([{ name: "up" }, { name: "up", ctrl: true }, { name: "down", shift: true }]);
    expect(p().feed("\x1b[5~\x1b[6~\x1b[3~")).toEqual([{ name: "pageup" }, { name: "pagedown" }, { name: "delete" }]);
    expect(p().feed("\x1bOA")).toEqual([{ name: "up" }]);
  });
  test("ctrl letters and backspace", () => {
    expect(p().feed("\x03\x7f")).toEqual([{ name: "char", text: "c", ctrl: true }, { name: "backspace" }]);
  });
  test("bracketed paste spanning chunks keeps newlines", () => {
    const k = p();
    expect(k.feed("\x1b[200~line one\r\nli")).toEqual([]);
    expect(k.feed("ne two\x1b[201~x")).toEqual([{ name: "paste", text: "line one\nline two" }, { name: "char", text: "x" }]);
  });
  test("lone escape is held until flushed; split sequences wait", () => {
    const k = p();
    expect(k.feed("\x1b")).toEqual([]);
    expect(k.flush()).toEqual([{ name: "escape" }]);
    expect(k.feed("\x1b[")).toEqual([]);
    expect(k.feed("B")).toEqual([{ name: "down" }]);
  });
});

// ── editor ───────────────────────────────────────────────────────────────────

describe("Editor", () => {
  test("multiline editing and joining", () => {
    const e = new Editor();
    e.insert("hello");
    e.newline();
    e.insert("world");
    expect(e.text).toBe("hello\nworld");
    e.home();
    e.backspace();
    expect(e.text).toBe("helloworld");
    expect(e.col).toBe(5);
  });
  test("pasted text with newlines and tabs", () => {
    const e = new Editor();
    e.insert("a\tb\r\nc");
    expect(e.text).toBe("a  b\nc");
    expect([e.row, e.col]).toEqual([1, 1]);
  });
  test("up/down move inside a draft before touching history", () => {
    const e = new Editor(["old"]);
    e.insert("one");
    e.newline();
    e.insert("two");
    e.up();
    expect(e.text).toBe("one\ntwo"); // moved a line, no history yet
    e.up();
    expect(e.text).toBe("old");
    e.down();
    expect(e.text).toBe("one\ntwo"); // draft restored
  });
  test("commit records history without duplicates", () => {
    const e = new Editor();
    e.insert("x");
    e.commit("x");
    e.insert("x");
    e.commit("x");
    expect(e.historyEntries).toEqual(["x"]);
    expect(e.isEmpty).toBe(true);
  });
  test("word deletion and kills", () => {
    const e = new Editor();
    e.insert("alpha beta  gamma");
    e.deleteWord();
    expect(e.text).toBe("alpha beta  ");
    e.home();
    e.wordRight();
    e.killToEnd();
    expect(e.text).toBe("alpha");
  });
});

// ── text + markdown ──────────────────────────────────────────────────────────

describe("text layout", () => {
  test("wrap never exceeds width, with wide characters and long words", () => {
    const line = [span("Plan: 漢字の計算機 supercalifragilisticexpialidocious-and-more words follow here")];
    for (const w of [5, 8, 13, 21, 40]) {
      for (const row of wrap(line, w, [span("  ")])) expect(lineWidth(row)).toBeLessThanOrEqual(w);
    }
  });
  test("wrap keeps words whole when possible and indents continuations", () => {
    const rows = wrap([span("aaa bbb ccc ddd")], 8, [span("  ")]);
    expect(rows.map(plain)).toEqual(["aaa bbb", "  ccc", "  ddd"]);
  });
  test("truncate adds an ellipsis within the budget", () => {
    expect(plain(truncate([span("abcdefghij")], 6))).toBe("abcde…");
    expect(lineWidth(truncate([span("漢字漢字漢字")], 5))).toBeLessThanOrEqual(5);
  });
  test("markdown: code fences get a gutter, bullets and quotes render", () => {
    const rows = renderMarkdown("Intro\n\n```ts\nconst x = 1;\n```\n- item **bold**\n> quoted", 40, UNICODE_GLYPHS).map(plain);
    expect(rows).toContain("┌─ ts");
    expect(rows).toContain("│ const x = 1;");
    expect(rows).toContain("· item bold");
    expect(rows).toContain("│ quoted");
  });
});

// ── frames ───────────────────────────────────────────────────────────────────

function sampleStore(): Store {
  const st = new Store(ctxInfo);
  st.set({ turn: 1, remembering: true });
  st.add({ kind: "divider", label: "turn 1 · 12:00" });
  st.add({ kind: "user", text: "Add a history feature with tests. ".repeat(4), time: new Date() });
  st.add({ kind: "assistant", text: "Plan:\n- one\n- two\n\n```py\nprint('x' * 200)\n```", streaming: false });
  st.add({ kind: "activity", category: "delegate", title: "coder\tImplement history", meta: "12s · 2 files", state: "ok", details: ["result", "line"], expanded: true, startedAt: Date.now(), taskId: "t-abcd" });
  st.add({ kind: "activity", category: "verify", title: "verify\tnpm test", meta: "", state: "running", details: [], expanded: false, startedAt: Date.now() });
  st.add({ kind: "error", message: "usage limit reached", hint: recoveryHint("usage limit reached") });
  st.upsertTask({ taskId: "2026-abcd", agent: "coder", state: "ok", title: "x", files: 2, pending: true });
  st.set({ decision: { taskId: "2026-abcd", agent: "coder", stat: { files: 2, added: 10, removed: 3 }, includes: 1, others: [] }, status: "deciding" });
  return st;
}

function frame(theme: Theme, w: number, h: number, mutate?: (s: Store) => void): Frame {
  const store = sampleStore();
  mutate?.(store);
  const ed = new Editor();
  ed.insert("draft line that is long enough to wrap in narrow terminals ".repeat(2));
  return renderFrame(store.state, ed, w, h, { theme, tick: 3, now: Date.now() });
}

describe("renderFrame", () => {
  const color = createTheme({ depth: "truecolor", ascii: false, reducedMotion: false });
  const sizes: [number, number][] = [[40, 16], [60, 24], [80, 24], [100, 30], [140, 44], [220, 60]];

  test("every row is exactly the terminal width and the frame fills the height", () => {
    for (const [w, h] of sizes) {
      const f = frame(color, w, h);
      expect(f.rows.length).toBe(h);
      for (const r of f.rows) expect(Bun.stringWidth(r)).toBe(w);
      expect(f.cursor!.row).toBeLessThan(h);
      expect(f.cursor!.col).toBeLessThan(w);
    }
  });

  test("context panel shows only on wide terminals and can be closed", () => {
    expect(strip(frame(color, 140, 44).rows.join("\n"))).toContain("C O N T E X T");
    expect(strip(frame(color, 90, 30).rows.join("\n"))).not.toContain("C O N T E X T");
    expect(strip(frame(color, 140, 44, (s) => s.set({ panelOpen: false })).rows.join("\n"))).not.toContain("C O N T E X T");
  });

  test("state is spelled out in words, not color alone", () => {
    const text = strip(frame(color, 140, 44).rows.join("\n"));
    expect(text).toContain("decision required");
    expect(text).toContain("DECISION REQUIRED");
    expect(text).toContain("[a] apply to your branch");
    expect(text).toContain("fault");
    expect(text).toContain("rate-limited"); // recovery hint
    for (const status of ["ready", "working", "complete", "fault", "cancelling"] as const) {
      const t = strip(frame(color, 120, 30, (s) => s.set({ status, decision: undefined })).rows[0]!);
      expect(t).toContain(status === "working" ? "working" : status);
    }
  });

  test("NO_COLOR mode emits no escape codes; ASCII mode emits only ASCII", () => {
    const none = createTheme({ depth: "none", ascii: false });
    for (const r of frame(none, 120, 30).rows) expect(r).not.toContain("\x1b");
    const ascii = createTheme({ depth: "none", ascii: true });
    for (const r of frame(ascii, 120, 30).rows) expect(/^[\x20-\x7e]*$/.test(r)).toBe(true);
  });

  test("reduced motion keeps glyphs still between ticks", () => {
    const still = createTheme({ depth: "none", ascii: false, reducedMotion: true });
    const store = sampleStore();
    store.set({ status: "working", decision: undefined, since: Date.now() });
    const at = (tick: number) => renderFrame(store.state, new Editor(), 120, 30, { theme: still, tick, now: 0 }).rows[0];
    expect(at(1)).toBe(at(9));
    const moving = createTheme({ depth: "none", ascii: false, reducedMotion: false });
    const m = (tick: number) => renderFrame(store.state, new Editor(), 120, 30, { theme: moving, tick, now: 0 }).rows[0];
    expect(m(0)).not.toBe(m(2));
  });

  test("help overlay lists keys and the sign legend", () => {
    const text = strip(frame(color, 120, 50, (s) => s.set({ helpOpen: true })).rows.join("\n"));
    expect(text).toContain("ctrl+o");
    expect(text).toContain("decision required");
    expect(text).toContain("/apply <task>");
  });

  test("tiny terminals get a clear message instead of a broken layout", () => {
    expect(strip(frame(color, 20, 6).rows[0]!)).toContain("terminal too");
  });
});

describe("theme detection", () => {
  test("color depth from environment", () => {
    expect(detectColorDepth({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("none");
    expect(detectColorDepth({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(detectColorDepth({ TERM: "xterm-256color" })).toBe("256");
    expect(detectColorDepth({ TERM: "xterm" })).toBe("16");
    expect(detectColorDepth({ TERM: "xterm-256color" }, false)).toBe("none");
  });
  test("ascii glyphs are ascii", () => {
    for (const v of Object.values(ASCII_GLYPHS).flat()) expect(/^[\x20-\x7e]+$/.test(v)).toBe(true);
  });
});

// ── interaction ──────────────────────────────────────────────────────────────

function result(taskId: string, ok = true): TaskResult {
  return { ok, summary: "done", usage: emptyUsage(), costUsd: 0.01, taskId, agent: "coder", exitCode: 0, durationMs: 1000, diff: "diff --git a/x b/x\n+new\n-old", filesChanged: ["x"], branch: ok ? `yxu/${taskId}` : undefined };
}

/** An engine the test drives step by step. */
function controllableEngine() {
  let release!: () => void;
  const calls: { goal: string; resume?: string }[] = [];
  const engine: Engine = {
    async run({ goal, render, abort, session, resume }) {
      calls.push({ goal, resume });
      render.textStart?.();
      render.textDelta?.("Work");
      render.textDelta?.("ing on it.");
      render.assistantText("Working on it.");
      render.toolCall("Read", { file_path: "/repo/a.ts" });
      render.toolCall("Read", { file_path: "/repo/b.ts" });
      render.hooks.onDelegateStart?.({ taskId: "t1", agent: "coder", task: "do it" });
      await new Promise<void>((r) => {
        release = r;
        abort.signal.addEventListener("abort", () => r(), { once: true });
      });
      if (abort.signal.aborted) return { runId: "r", ok: false, finalText: "cancelled", costUsd: 0.02, session, cancelled: true } as RunOutcome;
      const r = result("t1");
      session.tasks.set("t1", { ...r, prompt: "do it", parents: [] });
      render.hooks.onDelegateEnd?.(r);
      render.assistantText("All done.");
      return { runId: "r", ok: true, finalText: "All done.", costUsd: 0.05, session, sdkSessionId: "sess-1" } as RunOutcome;
    },
  };
  return { engine, calls, release: () => release() };
}

function memoryBackend(getSession: () => Session) {
  const applied: string[] = [];
  const gone = new Set<string>();
  const backend: TaskBackend = {
    exists: (id) => !gone.has(id) && !!getSession().tasks.get(id)?.branch,
    diff: () => "diff --git a/x b/x\n+new\n-old",
    apply: (id) => {
      applied.push(id);
      gone.add(id);
      return { ok: true, message: `merged yxu/${id} into main` };
    },
    discard: (id) => {
      gone.add(id);
      return { ok: true, message: `discarded ${id}` };
    },
  };
  return { backend, applied };
}

function makeApp(engine: Engine) {
  let frame: Frame = { rows: [] };
  let exited: unknown;
  let app!: App;
  const mem = memoryBackend(() => app.taskSession);
  app = new App({
    cfg,
    root: "/repo-does-not-exist",
    theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
    engine,
    backend: mem.backend,
    historyFile: null,
    catalog: testCatalog(),
    draw: (f) => (frame = f),
    size: () => ({ width: 120, height: 40 }),
    exit: (s) => (exited = s),
  });
  const screen = () => {
    app.render();
    return strip(frame.rows.join("\n"));
  };
  return { app, screen, applied: mem.applied, exited: () => exited };
}

const tick = () => Bun.sleep(5);

describe("App interaction", () => {
  test("goal → working → decision → apply → ready, with streaming and grouped reads", async () => {
    const { engine, release, calls } = controllableEngine();
    const { app, screen, applied } = makeApp(engine);
    app.input("Build the thing\r");
    await tick();
    expect(app.store.state.status).toBe("working");
    let s = screen();
    expect(s).toContain("Working on it.");
    expect(s).toContain("read"); // two Reads grouped into one activity
    expect(s).toContain("2 lookups");
    expect(s).toContain("1/3"); // one subagent slot lit
    expect(app.store.state.entries.filter((e) => e.kind === "assistant")).toHaveLength(1); // stream finalized, not duplicated

    release();
    await app.idle();
    expect(app.store.state.status).toBe("deciding");
    s = screen();
    expect(s).toContain("DECISION REQUIRED");
    expect(s).toContain("1 file · +1 −1");

    app.input("v");
    expect(screen()).toContain("diff t1");
    app.input("a");
    expect(applied).toEqual(["t1"]);
    expect(screen()).toContain("Applied. merged yxu/t1 into main.");
    expect(["complete", "ready"]).toContain(app.store.state.status);
    expect(app.store.state.cost.orchestrator).toBeCloseTo(0.05);
    expect(app.store.state.remembering).toBe(true);

    // The next message resumes the same orchestrator conversation.
    app.input("And now docs\r");
    await tick();
    expect(calls.at(-1)).toEqual({ goal: "And now docs", resume: "sess-1" });
    app.input("\x1b");
    await app.idle();
    app.dispose();
  });

  test("escape cancels a run; the branch-safety notice is shown", async () => {
    const { engine } = controllableEngine();
    const { app, screen } = makeApp(engine);
    app.input("Go\r");
    await tick();
    app.input("\x1b");
    await Bun.sleep(60); // lone ESC is flushed after a short delay
    await app.idle();
    const s = screen();
    expect(s).toContain("Cancelled. Your branch is untouched");
    expect(s).toContain("interrupted"); // the running activity is marked, not left spinning
    expect(app.store.state.status).not.toBe("working");
    app.dispose();
  });

  test("failures show a fault with a recovery path", async () => {
    const engine: Engine = { run: async ({ session }) => ({ runId: "r", ok: false, finalText: "429 rate limit exceeded", costUsd: 0, session }) };
    const { app, screen } = makeApp(engine);
    app.input("Go\r");
    await app.idle();
    const s = screen();
    expect(app.store.state.status).toBe("fault");
    expect(s).toContain("fault 429 rate limit exceeded");
    expect(s).toContain("rate-limited");
    app.dispose();
  });

  test("engine exceptions become faults instead of crashes", async () => {
    const engine: Engine = { run: async () => { throw new Error("claude not found on PATH"); } };
    const { app, screen } = makeApp(engine);
    app.input("Go\r");
    await app.idle();
    expect(screen()).toContain("yxu doctor");
    app.dispose();
  });

  test("submitting while working keeps the draft and explains why", async () => {
    const { engine, release } = controllableEngine();
    const { app, screen } = makeApp(engine);
    app.input("first\r");
    await tick();
    app.input("second\r");
    expect(app.editor.text).toBe("second");
    expect(screen()).toContain("an operation is running");
    release();
    await app.idle();
    app.dispose();
  });

  test("commands, help, multiline input, and double ctrl+c to exit", async () => {
    const { app, screen, exited } = makeApp(controllableEngine().engine);
    app.input("/nope\r");
    expect(screen()).toContain("unknown command /nope");
    app.input("/tasks\r");
    expect(screen()).toContain("No tasks in this session yet.");
    app.input("?");
    expect(screen()).toContain("K E Y S");
    app.input("\x1b");
    await Bun.sleep(60);
    expect(app.store.state.helpOpen).toBe(false);
    app.input("line one\x1b\rline two");
    expect(app.editor.text).toBe("line one\nline two");
    app.input("\x03"); // clears draft first
    expect(app.editor.isEmpty).toBe(true);
    app.input("\x03");
    expect(screen()).toContain("press ctrl+c again to exit");
    app.input("\x03");
    expect(exited()).toEqual({ pending: [] });
    app.dispose();
  });

  test("ctrl+o expands the latest activity; ctrl+p toggles the panel", async () => {
    const { engine, release } = controllableEngine();
    const { app, screen } = makeApp(engine);
    app.input("Go\r");
    await tick();
    release();
    await app.idle();
    app.input("l"); // decide later
    app.input("\x0f");
    expect(screen()).toContain("— result —");
    const before = app.store.state.panelOpen;
    app.input("\x10");
    expect(app.store.state.panelOpen).toBe(!before);
    app.dispose();
  });
});

// ── context & compaction controls ────────────────────────────────────────────

import { mkdtempSync as mkd, readFileSync as rd, rmSync as rmd, writeFileSync as wr } from "node:fs";
import { tmpdir as tmp } from "node:os";
import { join as pj } from "node:path";
import type { ContextUsage } from "../src/context.ts";

function usage(pct: number, auto = true): ContextUsage {
  return { tokens: pct * 2000, max: 200_000, percentage: pct, autoCompact: auto, threshold: 167_000, categories: [{ name: "Messages", tokens: pct * 1500, kind: "used" }] };
}

/** Engine that records what it was asked and reports configurable usage. */
function contextEngine(opts: { usage?: ContextUsage } = {}) {
  const runs: { resume?: string; memory: boolean; include: string[] }[] = [];
  const compactions: { instructions?: string; sessionId: string }[] = [];
  const engine: Engine = {
    async run({ session, resume, cfg }) {
      runs.push({ resume, memory: cfg.context.memory, include: [...cfg.context.include] });
      return { runId: "r", ok: true, finalText: "ok", costUsd: 0.01, session, sdkSessionId: `sess-${runs.length}`, context: opts.usage } as RunOutcome;
    },
    async compact({ sessionId, instructions, render }) {
      compactions.push({ sessionId, instructions });
      const compaction = { trigger: "manual" as const, preTokens: 50_000, postTokens: 14_000 };
      render.compacted?.(compaction);
      return { ok: true, compaction, context: usage(7), costUsd: 0.003 };
    },
  };
  return { engine, runs, compactions };
}

function appAt(root: string, engine: Engine) {
  let frame: Frame = { rows: [] };
  const app = new App({
    cfg: parseConfig(`# keep me\nagents:\n  coder: { cli: opencode }\n`, pj(root, "yxu.yaml")),
    root,
    theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
    engine,
    historyFile: null,
    catalog: testCatalog(),
    draw: (f) => (frame = f),
    size: () => ({ width: 140, height: 50 }),
    exit: () => {},
  });
  const screen = () => {
    app.render();
    return strip(frame.rows.join("\n"));
  };
  return { app, screen };
}

describe("context & compaction controls", () => {
  let root: string;
  const setup = () => {
    root = mkd(pj(tmp(), "yxu-tui-ctx-"));
    wr(pj(root, "yxu.yaml"), "# keep me\nagents:\n  coder: { cli: opencode }\n");
    wr(pj(root, "ARCH.md"), "architecture notes");
  };
  const teardown = () => rmd(root, { recursive: true, force: true });

  test("/context shows the report; memory off stops resuming", async () => {
    setup();
    const { engine, runs } = contextEngine({ usage: usage(20) });
    const { app, screen } = appAt(root, engine);
    app.input("first\r");
    await app.idle();
    app.input("/context\r");
    let s = screen();
    expect(s).toContain("memory: on — continuing (turn 1)");
    expect(s).toContain("window: 40k of 200k tokens (20%), auto-compacts at 167k");
    expect(s).toContain("largest: messages 30k");
    expect(s).toMatch(/window\s+▰▰▱▱▱▱▱▱ 20% 40k\/200k/); // panel gauge with a written percentage

    app.input("second\r");
    await app.idle();
    expect(runs[1]!.resume).toBe("sess-1");

    app.input("/context memory off\r");
    expect(screen()).toContain("Memory off: each message starts a fresh orchestrator conversation");
    app.input("third\r");
    await app.idle();
    expect(runs[2]).toMatchObject({ resume: undefined, memory: false });
    expect(screen()).toMatch(/memory\s+off/);
    app.dispose();
    teardown();
  });

  test("/context add|drop|notes validate input and reach the next run", async () => {
    setup();
    const { engine, runs } = contextEngine();
    const { app, screen } = appAt(root, engine);
    app.input("/context add nope.md\r");
    expect(screen()).toContain("nope.md does not exist");
    app.input("/context add ../outside.md\r");
    expect(screen()).toContain("outside the repository");
    app.input("/context add ARCH.md\r");
    app.input("/context notes Never touch migrations\r");
    let s = screen();
    expect(s).toContain("Added ARCH.md to the orchestrator's context");
    expect(s).toMatch(/added\s+1 file · notes/);
    app.input("go\r");
    await app.idle();
    expect(runs[0]!.include).toEqual(["ARCH.md"]);
    app.input("/context drop ARCH.md\r");
    expect(screen()).toContain("Removed ARCH.md");
    app.input("/context bogus\r");
    expect(screen()).toContain('unknown /context option "bogus"');
    app.dispose();
    teardown();
  });

  test("/compact settings, validation, and /context save keeps comments", () => {
    setup();
    const { app, screen } = appAt(root, contextEngine().engine);
    app.input("/compact window 50k\r");
    expect(screen()).toContain("usage: /compact window <100k–1m | auto>");
    app.input("/compact window 300k\r");
    app.input("/compact auto off\r");
    app.input("/compact instructions Keep API names\r");
    app.input("/compact warn 90%\r");
    expect(screen()).toMatch(/compact\s+off/);
    expect(app.cfg.compact).toMatchObject({ auto: false, window: 300_000, instructions: "Keep API names", warn_at: 0.9 });
    app.input("/context save\r");
    expect(screen()).toContain("Saved 4 settings");
    const saved = rd(pj(root, "yxu.yaml"), "utf8");
    expect(saved).toContain("# keep me");
    const back = parseConfig(saved, "x");
    expect(back.compact).toMatchObject({ auto: false, window: 300_000, instructions: "Keep API names", warn_at: 0.9 });
    app.dispose();
    teardown();
  });

  test("/compact needs a conversation, then summarizes it and updates the gauge", async () => {
    setup();
    const { engine, compactions } = contextEngine({ usage: usage(25) });
    const { app, screen } = appAt(root, engine);
    app.input("/compact\r");
    await Bun.sleep(5);
    expect(screen()).toContain("Nothing to compact yet");
    app.input("work\r");
    await app.idle();
    app.input("/compact keep the parser decisions\r");
    await Bun.sleep(20);
    const s = screen();
    expect(compactions).toEqual([{ sessionId: "sess-1", instructions: "keep the parser decisions" }]);
    expect(s).toContain("Conversation compacted (manual): 50k → 14k tokens");
    expect(s).toMatch(/compact\s+keep the parser decisions\s+50k → 14k tokens/);
    expect(s).toContain("7%");
    expect(app.store.state.cost.orchestrator).toBeCloseTo(0.013);
    app.dispose();
    teardown();
  });

  test("warns once when context passes the threshold; louder when auto-compaction is off", async () => {
    setup();
    const { engine } = contextEngine({ usage: usage(85, false) });
    const { app, screen } = appAt(root, engine);
    app.input("a\r");
    await app.idle();
    expect(screen()).toContain("auto-compaction is off. /compact summarizes it now");
    const count = () => app.store.state.entries.filter((e) => e.kind === "notice" && e.text.includes("auto-compaction is off")).length;
    app.input("b\r");
    await app.idle();
    expect(count()).toBe(1); // not repeated every turn
    app.dispose();
    teardown();
  });
});
