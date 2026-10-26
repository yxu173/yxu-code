import { formatTokens } from "../context.ts";
import { COMMANDS } from "./commands.ts";
import type { Editor } from "./editor.ts";
import { renderMarkdown } from "./markdown.ts";
import type { Entry, State, Status } from "./model.ts";
import { lineWidth, pad, sanitize, span, toAnsi, truncate, truncateText, width, wrap, wrapText, type Line } from "./text.ts";
import type { Glyphs, Style, Theme } from "./theme.ts";

export interface Frame {
  rows: string[];
  /** Where to place the terminal cursor (0-based), when the input is focused. */
  cursor?: { row: number; col: number };
}

export interface ViewContext {
  theme: Theme;
  /** Increments while working; drives the restrained pulse. */
  tick: number;
  now: number;
}

/** Below this width the context panel collapses instead of squeezing the conversation. */
export const PANEL_MIN_TOTAL = 100;
export const PANEL_WIDTH = 36;
const MAX_INPUT_ROWS = 8;

export interface Layout {
  width: number;
  height: number;
  main: number;
  panel: number;
  narrow: boolean;
}

export function computeLayout(state: State, width: number, height: number): Layout {
  const showPanel = (state.panelOpen || !!state.watch) && width >= PANEL_MIN_TOTAL;
  // Watching an agent: a wider panel, for its diff.
  const panel = showPanel ? (state.watch ? Math.max(PANEL_WIDTH, Math.min(72, Math.floor(width * 0.42))) : PANEL_WIDTH) : 0;
  return { width, height, main: width - panel, panel, narrow: width < 72 };
}

// ── small helpers ────────────────────────────────────────────────────────────

const s = span;

function rule(w: number, g: Glyphs, label?: Line, style: Style = { fg: "faint" }): Line {
  if (!label?.length) return [s(g.h.repeat(Math.max(0, w)), style)];
  const lw = lineWidth(label);
  const left = 1;
  const right = Math.max(0, w - lw - left - 2);
  return [s(g.h.repeat(left) + " ", style), ...label, s(" " + g.h.repeat(right), style)];
}

function shortId(id: string): string {
  return id.includes("-") ? id.slice(id.lastIndexOf("-") + 1) : id.slice(-6);
}

function elapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function pulse(ctx: ViewContext): string {
  const g = ctx.theme.glyphs;
  return ctx.theme.reducedMotion ? g.running : g.pulse[Math.floor(ctx.tick / 2) % g.pulse.length]!;
}

export const STATUS_WORD: Record<Status, string> = {
  ready: "Ready",
  working: "Working",
  deciding: "Your decision",
  complete: "Done",
  fault: "Something failed",
  cancelling: "Cancelling",
};

const repoName = (root: string) => root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || root;

export function header(state: State, w: number, ctx: ViewContext): Line {
  const g = ctx.theme.glyphs;
  const c = state.context;
  // Where you are: the repo and branch.
  const left: Line = [s(` ${g.mark} `, { fg: "cyan" }), s("yxu", { fg: "ivory", bold: true })];
  const where: Line = [s("   "), s(repoName(c.root), { fg: "ivory" }), ...(c.branch ? [s(` ${g.dot} `, { fg: "faint" }), s(c.branch, { fg: "dim" })] : [])];
  if (state.demo) left.push(s("  [demo — scripted, no agents]", { fg: "amber" }));

  // What is happening, in words.
  const st = state.status;
  const statusGlyph =
    st === "working" ? pulse(ctx) : st === "deciding" ? g.attention : st === "fault" ? g.fault : st === "complete" ? g.ok : st === "cancelling" ? g.running : g.idle;
  const statusStyle: Style =
    st === "working" ? { fg: "cyan", bold: true } : st === "deciding" || st === "cancelling" ? { fg: "amber", bold: true } : st === "fault" ? { fg: "fault", bold: true } : st === "complete" ? { fg: "cyan" } : { fg: "dim" };
  const status: Line = [s(`${statusGlyph} ${STATUS_WORD[st]}`, statusStyle)];
  if (st === "working" && state.since) status.push(s(` ${elapsed(ctx.now - state.since)}`, { fg: "dim" }));
  const detail = st === "working" && state.activeSlots ? `${state.activeSlots} agent${state.activeSlots === 1 ? "" : "s"} at work` : st === "working" || st === "fault" || st === "cancelling" ? state.statusNote : undefined;
  if (detail && w >= 72) status.push(s(` ${g.dot} ${detail}`, { fg: "dim" }));

  const right: Line = w >= 100 ? [s(`${c.model}${c.effort ? ` ${g.dot} ${c.effort}` : ""} ${g.dot} ${c.workflow} `, { fg: "dim" })] : [s(" ")];
  // Degrade gracefully: drop the detail, then the repo, then the model — never the status.
  const attempts: [Line, Line, Line][] = [
    [[...left, ...where], status, right],
    [[...left, ...where], status.slice(0, 2), right],
    [left, status.slice(0, 2), right],
    [left, status.slice(0, 2), [s(" ")]],
    [left.slice(0, 2), status.slice(0, 1), [s(" ")]],
  ];
  for (const [l, m, r] of attempts) {
    const gap = w - lineWidth(l) - lineWidth(m) - lineWidth(r);
    if (gap >= 6) return [...l, s(" ".repeat(gap - Math.floor(gap / 2))), ...m, s(" ".repeat(Math.floor(gap / 2))), ...r];
  }
  return truncate([...left.slice(0, 2), s("  "), ...status.slice(0, 1)], w);
}

// ── conversation ─────────────────────────────────────────────────────────────

const ENTRY_INDENT = 2;

function gutterLine(glyph: string, style: Style): Line {
  return [s(glyph, style), s(" ")];
}

/** Rendered rows per entry object (not id: ids are only unique within one store). */
const cache = new WeakMap<Entry, { key: string; rows: Line[] }>();

/** Rows for one entry at width `w`. Cached unless it depends on time. */
export function entryRows(e: Entry, w: number, state: State, ctx: ViewContext): Line[] {
  const live = e.kind === "activity" && e.state === "running";
  const selected = e.kind === "activity" && state.selected === e.id;
  const key = `${e.version}:${w}:${selected ? 1 : 0}:${ctx.theme.ascii ? 1 : 0}`;
  if (!live) {
    const hit = cache.get(e);
    if (hit?.key === key) return hit.rows;
  }
  const rows = renderEntry(e, w, selected, ctx);
  if (!live) cache.set(e, { key, rows });
  return rows;
}

function renderEntry(e: Entry, w: number, selected: boolean, ctx: ViewContext): Line[] {
  const g = ctx.theme.glyphs;
  const inner = Math.max(10, w - ENTRY_INDENT - 2);
  const indent: Line = [s(" ".repeat(ENTRY_INDENT))];

  switch (e.kind) {
    case "divider": {
      const label: Line = [s(`${g.memory} `, { fg: "violet" }), s(e.label, { fg: "violet" })];
      const lw = lineWidth(label) + 2;
      const side = Math.max(2, Math.floor((w - lw) / 2) - 1);
      return [[], [s(" "), s(g.h.repeat(side), { fg: "faint" }), s(" "), ...label, s(" "), s(g.h.repeat(Math.max(2, w - lw - side - 2)), { fg: "faint" })]];
    }

    case "user": {
      const rows = wrapText(e.text, inner, { fg: "ivory", bold: true });
      const out: Line[] = [[], ...rows.map((r, i) => [...(i === 0 ? gutterLine(g.you, { fg: "cyan", bold: true }) : indent), ...r])];
      for (const img of e.images ?? []) out.push(truncate([...indent, s(`${g.image} `, { fg: "violet" }), s(img, { fg: "dim" })], w));
      return out;
    }

    case "assistant": {
      const md = renderMarkdown(e.text, inner, g);
      if (e.streaming) {
        const caret = s(ctx.theme.ascii ? "_" : "▍", { fg: "cyan" });
        if (md.length) md[md.length - 1] = [...md.at(-1)!, caret];
        else md.push([caret]);
      }
      return [[], ...md.map((r, i) => [...(i === 0 ? gutterLine(g.machine, { fg: "ivory" }) : indent), ...r])];
    }

    case "step": {
      const numeral = g.step[e.index - 1] ?? String(e.index);
      const label: Line = [s(numeral, { fg: "violet", bold: true }), s("  "), s(e.name, { fg: "ivory", bold: true }), s(`  ${e.type}`, { fg: "dim" })];
      const lw = lineWidth(label);
      return [[], [s(" "), ...label, s("  "), s(g.h.repeat(Math.max(0, w - lw - 4)), { fg: "faint" }), s(` ${e.index}/${e.total}`, { fg: "faint" })]];
    }

    case "activity": {
      const glyph =
        e.state === "running" ? pulse(ctx) : e.state === "ok" ? g.ok : e.state === "failed" ? g.fault : g.idle;
      const gStyle: Style = e.state === "running" ? { fg: "cyan" } : e.state === "failed" ? { fg: "fault" } : { fg: "dim" };
      const marker = e.details.length ? (e.expanded ? g.collapse : g.expand) : " ";
      const meta = e.state === "running" ? `${elapsed(ctx.now - e.startedAt)}${e.meta ? ` · ${e.meta}` : ""}` : e.meta;
      const lead: Line = [s(selected ? (ctx.theme.ascii ? ">" : "›") : " ", { fg: "cyan", bold: true }), s(glyph, gStyle), s(" ")];
      const name = e.category === "read" ? "read" : e.title.split("\t")[0]!;
      const desc = e.title.includes("\t") ? e.title.split("\t")[1]! : "";
      const nameCol: Line = [s(truncateText(name, 12).padEnd(12), { fg: e.state === "failed" ? "fault" : "ivory", bold: selected })];
      const right: Line = [s(meta ? ` ${meta}` : "", { fg: e.state === "failed" ? "fault" : "dim" }), s(` ${marker}`, { fg: selected ? "cyan" : "faint", bold: selected })];
      const avail = w - lineWidth(lead) - lineWidth(nameCol) - lineWidth(right) - 1;
      const descLine: Line = avail > 4 ? truncate([s(desc, { fg: "dim" })], avail) : [];
      const fill = Math.max(0, avail - lineWidth(descLine));
      const row: Line = [...lead, ...nameCol, s(" "), ...descLine, s(" ".repeat(fill)), ...right];
      const rows: Line[] = [truncate(row, w)];
      if (e.expanded && e.details.length) {
        const max = 80;
        const shown = e.details.slice(0, max);
        for (const d of shown) rows.push(...wrapText(d, Math.max(10, w - 6), { fg: "dim" }).map((r) => [s("     "), ...r]));
        if (e.details.length > max) rows.push([s("     "), s(`${g.ellipsis} ${e.details.length - max} more lines`, { fg: "faint" })]);
      }
      return rows;
    }

    case "notice": {
      const tone = { info: { g: g.dot, st: { fg: "dim" } }, ok: { g: g.ok, st: { fg: "cyan" } }, memory: { g: g.memory, st: { fg: "violet" } }, attention: { g: g.attention, st: { fg: "amber" } } }[e.tone] as { g: string; st: Style };
      // Notices use the same light markdown as responses (bold, `code`, lists).
      const rows = renderMarkdown(e.text, inner, g, e.tone === "info" ? { fg: "dim" } : { fg: "ivory" });
      return [[], ...rows.map((r, i) => [...(i === 0 ? gutterLine(tone.g, tone.st) : indent), ...r])];
    }

    case "error": {
      const head: Line = [s(`${g.fault} `, { fg: "fault", bold: true }), s("fault ", { fg: "fault", bold: true })];
      const rows = wrap([...head, ...sanitize(e.message).split("\n").flatMap((l, i) => (i ? [s(" ")] : []).concat([s(l, { fg: "ivory" })]))], w - 1, indent);
      const out: Line[] = [[], ...rows];
      if (e.hint) out.push(...wrap([s(`${g.arrow} `, { fg: "amber" }), s(e.hint, { fg: "dim" })], w - 3, [s(" ".repeat(width(g.arrow) + 1))]).map((r) => [s("  "), ...r]));
      return out;
    }

    case "diff": {
      const out: Line[] = [[], [s(" "), s(g.memory, { fg: "violet" }), s(` diff ${e.taskId}`, { fg: "ivory", bold: true })]];
      const lines = sanitize(e.text).split("\n");
      const max = 600;
      for (const l of lines.slice(0, max)) {
        const st: Style = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff --git")
          ? { fg: "ivory", bold: true }
          : l.startsWith("+")
            ? { fg: "cyan" }
            : l.startsWith("-")
              ? { fg: "amber" }
              : l.startsWith("@@")
                ? { fg: "violet" }
                : { fg: "dim" };
        out.push(truncate([s("   "), s(l || " ", st)], w, g.ellipsis));
      }
      if (lines.length > max) out.push([s("   "), s(`${g.ellipsis} ${lines.length - max} more lines (yxu show ${e.taskId})`, { fg: "faint" })]);
      return out;
    }
  }
}

/** All conversation rows at width `w`, plus the row index where each entry starts. */
export function conversationRows(state: State, w: number, ctx: ViewContext): { rows: Line[]; starts: Map<number, number> } {
  const rows: Line[] = [];
  const starts = new Map<number, number>();
  let prev: Entry | undefined;
  for (const e of state.entries) {
    // A blank row before each group of activity, so tool work reads as its own block.
    if (e.kind === "activity" && prev && prev.kind !== "activity") rows.push([]);
    starts.set(e.id, rows.length);
    for (const r of entryRows(e, w, state, ctx)) rows.push(r);
    prev = e;
  }
  return { rows, starts };
}

function welcome(state: State, w: number, h: number, ctx: ViewContext): Line[] {
  const g = ctx.theme.glyphs;
  const c = state.context;
  const col = Math.min(w - 4, 78);
  const lines: Line[] = [];
  const para = (text: string, st: Style) => lines.push(...wrapText(text, col, st));
  lines.push([s(`${g.mark} `, { fg: "cyan" }), s("What should we work on?", { fg: "ivory", bold: true })]);
  lines.push([]);
  para(
    `Describe a goal in plain words. The orchestrator plans it, your agents do the work in their own copies of the repo, and nothing touches ${c.branch || "your branch"} until you apply it.`,
    { fg: "dim" },
  );
  lines.push([]);
  const item = (cmd: string, about: string, cmdStyle: Style = { fg: "cyan" }, width = Math.min(34, Math.floor(col / 2) - 3)) => {
    const left = truncateText(cmd, width).padEnd(width + 2);
    lines.push(truncate([s("  "), s(left, cmdStyle), s(about, { fg: "dim" })], col));
  };
  lines.push([s("Try", { fg: "violet", bold: true })]);
  item("Add a --verbose flag to the CLI", "just describe it", { fg: "ivory" });
  item("/issue 123", "work on a GitHub issue");
  item("/run feature add CSV export", "scout, plan, build, test, review");
  item("/map checkout", "find where things live");
  const recent = (state.recent ?? []).slice(0, 3);
  if (recent.length) {
    lines.push([]);
    lines.push([s("Pick up where you left off", { fg: "violet", bold: true })]);
    const idw = Math.max(...recent.map((r) => r.id.length)) + 8;
    for (const r of recent) item(`/resume ${r.id}`, `${r.title} ${g.dot} ${r.ago}`, { fg: "cyan" }, idw);
  }
  const pending = state.tasks.filter((t) => t.pending).length;
  if (pending) {
    lines.push([]);
    lines.push([s(`${g.attention} `, { fg: "amber" }), s(`${pending} result${pending === 1 ? " is" : "s are"} waiting for you: `, { fg: "ivory" }), s("/tasks", { fg: "cyan" })]);
  }
  lines.push([]);
  lines.push(truncate([s(`${c.agents.length} agents ${g.dot} ${c.workflow} workflow ${g.dot} `, { fg: "faint" }), s("/", { fg: "dim" }), s(" commands ", { fg: "faint" }), s(g.dot, { fg: "faint" }), s(" ?", { fg: "dim" }), s(" help", { fg: "faint" })], col));
  const top = Math.max(1, Math.floor((h - lines.length) / 3));
  const leftPad = s(" ".repeat(Math.max(2, Math.floor((w - col) / 2))));
  return [...Array.from({ length: top }, () => []), ...lines.map((l) => [leftPad, ...l])];
}

// ── help ─────────────────────────────────────────────────────────────────────

export const KEY_HELP: [string, string][] = [
  ["enter", "send"],
  ["alt+enter  ctrl+j", "new line"],
  ["↑ ↓", "move / history"],
  ["pgup pgdn  mouse wheel", "scroll conversation (shift+wheel: a page)"],
  ["ctrl+v", "attach the image on the clipboard (or drag an image file in)"],
  ["shift+drag", "select text (the wheel belongs to yxu; ui.mouse: false gives it back)"],
  ["end", "follow newest output"],
  ["ctrl+↑ ctrl+↓", "select activity"],
  ["ctrl+o", "expand / collapse details"],
  ["ctrl+p", "toggle context panel"],
  ["esc  ctrl+c", "cancel the running operation"],
  ["ctrl+c ctrl+c  ctrl+d", "exit"],
  ["ctrl+l", "redraw"],
];

/** Help lists the same commands the palette runs (one registry, no drift). */
export const COMMAND_HELP: [string, string][] = COMMANDS.map((c) => [`/${c.name}${c.usage ? ` ${c.usage}` : ""}`, c.description]);

function helpRows(state: State, w: number, ctx: ViewContext): Line[] {
  const g = ctx.theme.glyphs;
  const legend: [string, Style, string][] = [
    [g.you, { fg: "cyan" }, "your message"],
    [g.machine, { fg: "ivory" }, "orchestrator response"],
    [g.running, { fg: "cyan" }, "activity running"],
    [g.ok, { fg: "dim" }, "activity done"],
    [g.fault, { fg: "fault" }, "fault"],
    [g.attention, { fg: "amber" }, "decision required"],
    [g.memory, { fg: "violet" }, "memory / context"],
  ];
  const rows: Line[] = [[], [s(" "), s("Keys", { fg: "violet", bold: true })]];
  for (const [k, d] of KEY_HELP) rows.push([s("   "), s(k.padEnd(24), { fg: "ivory" }), s(d, { fg: "dim" })]);
  rows.push([], [s(" "), s("Commands", { fg: "violet", bold: true })]);
  rows.push([s("   "), s("type / in the message box to browse and complete these", { fg: "faint" })]);
  for (const [k, d] of COMMAND_HELP) rows.push([s("   "), s(truncateText(k, 30).padEnd(32), { fg: "ivory" }), s(d, { fg: "dim" })]);
  if (state.customHelp?.length) {
    rows.push([], [s(" "), s("Your commands", { fg: "violet", bold: true })]);
    rows.push([s("   "), s("from .yxu/commands and ~/.config/yxu/commands", { fg: "faint" })]);
    for (const [k, d] of state.customHelp) rows.push([s("   "), s(truncateText(k, 30).padEnd(32), { fg: "ivory" }), s(d, { fg: "dim" })]);
  }
  rows.push([], [s(" "), s("Signs", { fg: "violet", bold: true })]);
  for (const [gl, st, d] of legend) rows.push([s("   "), s(gl, st), s("  "), s(d, { fg: "dim" })]);
  rows.push([], [s("   "), s("press ? or esc to close", { fg: "faint" })]);
  return rows.map((r) => truncate(r, w));
}

// ── context panel ────────────────────────────────────────────────────────────

export function panelRows(state: State, w: number, h: number, ctx: ViewContext): Line[] {
  const g = ctx.theme.glyphs;
  const c = state.context;
  const inner = w - 3;
  const kv = (k: string, v: string, st: Style = { fg: "ivory" }): Line => truncate([s(k.padEnd(9), { fg: "dim" }), s(v, st)], inner);
  // Plain titles: easy to scan, no letter-spacing.
  const title = (t: string, extra?: Line): Line => [s(t[0]!.toUpperCase() + t.slice(1), { fg: "violet", bold: true }), ...(extra ?? [])];

  const ctxRows: Line[] = [
    title("context"),
    kv("workflow", c.mode === "auto" ? c.workflow : `${c.workflow} (pipeline)`),
    kv("model", `${c.model}${c.effort ? ` ${g.dot} ${c.effort}` : ""}`),
    kv("branch", c.branch || "(detached)"),
    kv("memory", !c.memory ? "off" : state.remembering ? `turn ${state.turn}` : "new conversation", { fg: state.remembering ? "violet" : "dim" }),
  ];
  const u = state.usage;
  if (u && u.max > 0) {
    // Gauge: filled cells + a written percentage, so it never depends on color.
    const cells = 6;
    const filled = Math.min(cells, Math.round((u.tokens / u.max) * cells));
    const hot = u.percentage / 100 >= c.compact.warnAt;
    ctxRows.push(
      truncate(
        [
          s("context".padEnd(9), { fg: "dim" }),
          s(g.gaugeFull.repeat(filled), { fg: hot ? "amber" : "cyan" }),
          s(g.gaugeEmpty.repeat(cells - filled), { fg: "faint" }),
          s(` ${Math.round(u.percentage)}%`, hot ? { fg: "amber", bold: true } : { fg: "ivory" }),
          s(` of ${formatTokens(u.max)}`, { fg: "dim" }),
        ],
        inner,
      ),
    );
  }
  if (state.compactingInBackground) ctxRows.push(kv("compact", "summarizing…", { fg: "violet" }));
  else if (!c.compact.auto) ctxRows.push(kv("compact", "off", { fg: "amber" }));
  const extras = [
    c.include.length ? `${c.include.length} file${c.include.length === 1 ? "" : "s"}` : "",
    c.hasNotes ? "notes" : "",
    c.projectInstructions ? "" : "no CLAUDE.md",
  ].filter(Boolean);
  if (extras.length) ctxRows.push(kv("added", extras.join(" · "), { fg: "violet" }));
  if (c.verify) ctxRows.push(kv("checks", c.verify, { fg: "dim" }));

  // Agents grouped by the model they run, so ten agents fit in a few rows; busy ones light up.
  const busy = new Set(state.tasks.filter((t) => t.state === "running").map((t) => t.agent));
  const agentRows: Line[] = [
    title("agents", [s(`  ${state.activeSlots ? `${state.activeSlots} of ${c.concurrency} at work` : `${c.agents.length}, ${c.concurrency} at a time`}`, { fg: state.activeSlots ? "cyan" : "faint" })]),
  ];
  const groups = new Map<string, string[]>();
  for (const a of c.agents) {
    const key = `${a.cli}\t${a.model ? a.model.split("/").at(-1) : "default model"}`;
    groups.set(key, [...(groups.get(key) ?? []), a.name]);
  }
  for (const [key, names] of groups) {
    const [cli, model] = key.split("\t") as [string, string];
    agentRows.push(truncate([s(`${cli} `, { fg: "faint" }), s(model, { fg: "dim" })], inner));
    const line: Line = [s("  ")];
    let used = 2;
    for (const n of names) {
      const piece = busy.has(n) ? `${pulse(ctx)} ${n}` : n;
      if (used + piece.length + 1 > inner && used > 2) {
        agentRows.push(line.splice(0));
        line.push(s("  "));
        used = 2;
      }
      line.push(s(piece, busy.has(n) ? { fg: "cyan", bold: true } : { fg: "ivory" }), s(" "));
      used += piece.length + 1;
    }
    agentRows.push(line);
  }

  const taskRows: Line[] = [title("tasks")];
  if (!state.tasks.length) taskRows.push([s("none yet", { fg: "faint" })]);
  const tasks = state.tasks.slice(-10);
  for (const t of tasks) {
    const glyph = t.state === "running" ? pulse(ctx) : t.state === "failed" ? g.fault : t.state === "discarded" ? g.idle : t.pending ? g.attention : g.ok;
    const st: Style = t.state === "running" ? { fg: "cyan" } : t.state === "failed" ? { fg: "fault" } : t.pending ? { fg: "amber" } : { fg: "dim" };
    const tag = t.pending ? "to apply" : t.state === "running" ? "working" : t.state === "ok" ? "done" : t.state;
    taskRows.push(
      truncate([s(glyph, st), s(" "), s(`${t.agent}`.padEnd(10), { fg: "ivory" }), s(`${tag}`.padEnd(9), t.pending ? { fg: "amber" } : st.fg === "cyan" ? { fg: "cyan" } : { fg: "dim" }), s(shortId(t.taskId), { fg: "faint" })], inner),
    );
  }
  if (state.tasks.length > tasks.length) taskRows.push([s(`${g.ellipsis} ${state.tasks.length - tasks.length} earlier`, { fg: "faint" })]);

  const money = (n: number) => (n === 0 ? "$0.00" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
  const costRows: Line[] = [
    title("cost", [s(`  ${money(state.cost.orchestrator + state.cost.subagents)}`, { fg: "ivory" })]),
    truncate([s(money(state.cost.orchestrator), { fg: "dim" }), s(" orchestrator  ", { fg: "faint" }), s(money(state.cost.subagents), { fg: "dim" }), s(" agents", { fg: "faint" })], inner),
  ];

  const sections: Record<string, Line[]> = { context: ctxRows, agents: agentRows, tasks: taskRows, cost: costRows };
  if (state.watch) {
    const wv = state.watch;
    const secs = Math.floor((Date.now() - wv.startedAt) / 1000);
    const stateStyle: Style = wv.state === "running" ? { fg: "cyan" } : wv.state === "finished" ? { fg: "dim" } : { fg: "amber", bold: true };
    const label = wv.state === "user" ? "yours — /done hands it back" : wv.state;
    const w: Line[] = [
      title("watch", [s(`  ${shortId(wv.taskId)}${wv.follow ? " (following)" : ""}`, { fg: "faint" })]),
      truncate([s(wv.agent, { fg: "ivory" }), s(`${wv.model ? ` · ${wv.model.split("/").at(-1)}` : ""} · `, { fg: "dim" }), s(label, stateStyle), s(` ${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`, { fg: "dim" })], inner),
    ];
    for (const l of wv.log.slice(-3)) w.push(truncate([s(`${g.attention} ${l}`, { fg: "violet" })], inner));
    w.push([s("activity", { fg: "dim" })]);
    if (!wv.activity.length) w.push([s("  waiting for the agent…", { fg: "faint" })]);
    for (const a of wv.activity.slice(-8)) w.push(truncate([s(`  ${a}`, { fg: a.startsWith("✗") || a.startsWith("!") ? "fault" : "ivory" })], inner));
    const add = wv.files.reduce((n, f) => n + f.added, 0);
    const del = wv.files.reduce((n, f) => n + f.removed, 0);
    w.push([s("changes", { fg: "dim" }), s(wv.files.length ? `  ${wv.files.length} file${wv.files.length === 1 ? "" : "s"} +${add} −${del}` : "  none yet", { fg: "faint" })]);
    for (const f of wv.files.slice(0, 6)) w.push(truncate([s(`  ${f.path} `, { fg: "ivory" }), s(`+${f.added}`, { fg: "cyan" }), s(` −${f.removed}`, { fg: "fault" })], inner));
    if (wv.diffTail.length) {
      w.push([s("diff (last lines)", { fg: "dim" })]);
      for (const l of wv.diffTail.slice(-10)) w.push(truncate([s(`  ${l}`, { fg: l.startsWith("+") ? "cyan" : l.startsWith("-") ? "fault" : "faint" })], inner));
    }
    w.push(truncate([s(wv.state === "finished" ? "/watch off closes this" : "/tell <msg> · /pause · /takeover · /watch off", { fg: "faint" })], inner));
    sections.watch = w;
  }
  for (const p of state.pluginPanels ?? []) {
    sections[p.id] = [title(p.title), ...(p.lines.length ? p.lines.slice(0, 12).map((l) => truncate([s(l, { fg: "dim" })], inner)) : [[s("nothing to show", { fg: "faint" })]])];
  }
  const order = [...(state.watch ? ["watch"] : []), ...(state.layout?.sections ?? ["context", "agents", "tasks", "cost"])];
  const extra = (state.pluginPanels ?? []).map((p) => p.id).filter((id) => !order.includes(id));
  const rows: Line[] = [...order, ...extra].flatMap((name) => (sections[name] ? [[], ...sections[name]] : []));

  return rows.slice(0, h).map((r) => [s(` ${g.v} `, { fg: "faint", bg: "panel" }), ...r.map((x) => ({ ...x, bg: "panel" as const }))]);
}

// ── decision boundary ────────────────────────────────────────────────────────

export function decisionRows(state: State, w: number, ctx: ViewContext): Line[] {
  const d = state.decision;
  if (!d) return [];
  const g = ctx.theme.glyphs;
  const amber: Style = { fg: "amber" };
  const inner = w - 4;
  const label: Line = [s(` ${g.attention} `, { fg: "amber", bold: true }), s("DECISION REQUIRED", { fg: "amber", bold: true }), s(" ")];
  const top: Line = [s(g.tlh + g.hh, amber), ...label, s(g.hh.repeat(Math.max(0, w - lineWidth(label) - 3)) + g.trh, amber)];
  const body: Line[] = [
    [s("Result ", { fg: "dim" }), s(d.taskId, { fg: "ivory", bold: true }), s(` · ${d.agent}`, { fg: "dim" })],
    [
      s(`${d.stat.files} file${d.stat.files === 1 ? "" : "s"}`, { fg: "ivory" }),
      s(` · +${d.stat.added} −${d.stat.removed}`, { fg: "dim" }),
      ...(d.includes ? [s(` · includes ${d.includes} earlier task${d.includes === 1 ? "" : "s"}`, { fg: "dim" })] : []),
      ...(d.others.length ? [s(` · ${d.others.length} other result${d.others.length === 1 ? "" : "s"} pending`, { fg: "amber" })] : []),
    ],
  ];
  const options: Line = [
    s("[a]", { fg: "amber", bold: true }), s(" apply to your branch   ", { fg: "ivory" }),
    s("[v]", { fg: "amber", bold: true }), s(" view diff   ", { fg: "ivory" }),
    s("[p]", { fg: "amber", bold: true }), s(" pull request   ", { fg: "ivory" }),
    s("[l]", { fg: "amber", bold: true }), s(" later   ", { fg: "ivory" }),
    s("[x]", { fg: "amber", bold: true }), s(" discard", { fg: "ivory" }),
  ];
  const lines = [...body.flatMap((b) => wrap(b, inner)), ...wrap(options, inner)];
  const framed = lines.map((l) => [s(`${g.vh} `, amber), ...pad(l, inner), s(` ${g.vh}`, amber)]);
  const bottom: Line = [s(g.blh + g.hh.repeat(Math.max(0, w - 2)) + g.brh, amber)];
  return [top, ...framed, bottom];
}

/** An agent asks to use a tool: allow once, allow for the session, or deny. */
export function approvalRows(state: State, w: number, ctx: ViewContext): Line[] {
  const ap = state.approval;
  if (!ap) return [];
  const g = ctx.theme.glyphs;
  const amber: Style = { fg: "amber" };
  const inner = w - 4;
  const label: Line = [s(` ${g.attention} `, { fg: "amber", bold: true }), s("AGENT ASKS", { fg: "amber", bold: true }), s(" ")];
  const top: Line = [s(g.tlh + g.hh, amber), ...label, s(g.hh.repeat(Math.max(0, w - lineWidth(label) - 3)) + g.trh, amber)];
  const lines = [
    ...wrap([s(ap.message, { fg: "ivory" })], inner),
    [s(`not covered by ${ap.agent}'s permissions${ap.waiting ? ` · ${ap.waiting} more waiting` : ""}`, { fg: "dim" })],
    ...wrap(
      [
        s("[y]", { fg: "amber", bold: true }), s(" allow once   ", { fg: "ivory" }),
        s("[a]", { fg: "amber", bold: true }), s(" allow for this session   ", { fg: "ivory" }),
        s("[n]", { fg: "amber", bold: true }), s(" deny", { fg: "ivory" }),
      ],
      inner,
    ),
  ];
  const framed = lines.map((l) => [s(`${g.vh} `, amber), ...pad(l, inner), s(` ${g.vh}`, amber)]);
  return [top, ...framed, [s(g.blh + g.hh.repeat(Math.max(0, w - 2)) + g.brh, amber)]];
}

/** A workflow gate: the run waits until the user continues or stops it. */
export function gateRows(state: State, w: number, ctx: ViewContext): Line[] {
  const gt = state.gate;
  if (!gt) return [];
  const g = ctx.theme.glyphs;
  const amber: Style = { fg: "amber" };
  const inner = w - 4;
  const label: Line = [s(` ${g.attention} `, { fg: "amber", bold: true }), s("APPROVAL REQUIRED", { fg: "amber", bold: true }), s(" ")];
  const top: Line = [s(g.tlh + g.hh, amber), ...label, s(g.hh.repeat(Math.max(0, w - lineWidth(label) - 3)) + g.trh, amber)];
  const lines = [
    ...gt.message.split("\n").flatMap((m) => wrap([s(m, { fg: "ivory" })], inner)),
    [s(`step ${gt.stepId} · the workflow waits for you`, { fg: "dim" })],
    ...wrap(
      [s("[y]", { fg: "amber", bold: true }), s(" continue   ", { fg: "ivory" }), s("[n]", { fg: "amber", bold: true }), s(" stop the workflow", { fg: "ivory" })],
      inner,
    ),
  ];
  const framed = lines.map((l) => [s(`${g.vh} `, amber), ...pad(l, inner), s(` ${g.vh}`, amber)]);
  return [top, ...framed, [s(g.blh + g.hh.repeat(Math.max(0, w - 2)) + g.brh, amber)]];
}

// ── slash-command palette ────────────────────────────────────────────────────

const PALETTE_ROWS = 8;

export function paletteRows(state: State, w: number, ctx: ViewContext): Line[] {
  const p = state.palette;
  if (!p) return [];
  const g = ctx.theme.glyphs;
  const rows: Line[] = [];
  if (p.hint) rows.push(truncate([s("  "), s(p.hint, { fg: "faint" })], w));
  if (p.status) rows.push(truncate([s("  "), s(p.status, /could not/.test(p.status) ? { fg: "fault" } : /loading/.test(p.status) ? { fg: "cyan" } : { fg: "violet" })], w));
  if (!p.items.length) {
    if (p.mode === "arg") rows.push([s("  "), s("type the value, then enter", { fg: "faint" })]);
    return rows;
  }
  const labels = p.items.map((i) => i.label ?? i.value);
  const col = Math.min(Math.max(...labels.map((l) => width(l))) + 3, Math.floor(w * 0.45));
  // Window the list around the selection.
  const start = Math.max(0, Math.min(p.selected - Math.floor(PALETTE_ROWS / 2), p.items.length - PALETTE_ROWS));
  const shown = p.items.slice(start, start + PALETTE_ROWS);
  shown.forEach((item, i) => {
    const sel = start + i === p.selected;
    const label = truncateText(labels[start + i]!, col - 3);
    rows.push(
      truncate(
        [
          s(sel ? (ctx.theme.ascii ? " > " : " › ") : "   ", { fg: "cyan", bold: true }),
          s(label.padEnd(col - 3 + (label.length - width(label))), sel ? { fg: "cyan", bold: true } : { fg: "ivory" }),
          s("  "),
          s(item.description ?? "", sel ? { fg: "ivory" } : { fg: "dim" }),
        ],
        w,
      ),
    );
  });
  if (p.items.length > PALETTE_ROWS) {
    rows.push([s(`   ${g.dot} ${p.selected + 1} of ${p.items.length}`, { fg: "faint" })]);
  }
  return rows;
}

// ── input + footer ───────────────────────────────────────────────────────────

/** Soft-wrap editor lines by cells; returns rows and the cursor's (row, col). */
export function inputRows(editor: Editor, w: number, prefixWidth: number): { rows: string[]; cursor: { row: number; col: number } } {
  const avail = Math.max(4, w - prefixWidth - 1);
  const rows: string[] = [];
  let cursor = { row: 0, col: 0 };
  editor.lines.forEach((line, li) => {
    const chars = [...line];
    let cur = "";
    let used = 0;
    let placed = false;
    for (let i = 0; i <= chars.length; i++) {
      if (li === editor.row && i === editor.col && !placed) {
        if (used >= avail) {
          rows.push(cur);
          cur = "";
          used = 0;
        }
        cursor = { row: rows.length, col: used };
        placed = true;
      }
      if (i === chars.length) break;
      const ch = chars[i]!;
      const cw = width(ch);
      if (used + cw > avail) {
        rows.push(cur);
        cur = "";
        used = 0;
      }
      cur += ch;
      used += cw;
    }
    rows.push(cur);
  });
  return { rows, cursor };
}

function footerRow(state: State, w: number, ctx: ViewContext): Line {
  if (state.flash) return truncate([s(" "), s(state.flash, { fg: "amber" })], w);
  const keys: [string, string][] =
    state.palette
      ? [["↑↓", "select"], ["tab", "complete"], ["enter", "run"], ["esc", "close"]]
      : state.helpOpen
      ? [["↑↓ pgup/pgdn", "scroll"], ["esc", "close help"]]
      : state.approval
      ? [["y", "allow once"], ["a", "allow for session"], ["n", "deny"], ["?", "help"]]
      : state.gate
      ? [["y", "continue"], ["n", "stop the workflow"], ["pgup/pgdn", "scroll"], ["?", "help"]]
      : state.status === "deciding"
        ? [["a", "apply"], ["v", "view diff"], ["p", "pull request"], ["l", "later"], ["x", "discard"]]
        : state.status === "working" || state.status === "cancelling"
          ? [["esc", "cancel"], ["/watch", "follow an agent"], ["ctrl+o", "details"], ["?", "help"]]
          : [["enter", "send"], ["/", "commands"], ["alt+enter", "new line"], ["↑", "history"], ["ctrl+p", "panel"], ["?", "help"]];
  const out: Line = [s("  ")];
  keys.forEach(([k, d], i) => {
    const piece: Line = [...(i ? [s(`  ${ctx.theme.glyphs.dot}  `, { fg: "faint" })] : []), s(k, { fg: "dim", bold: true }), s(` ${d}`, { fg: "faint" })];
    if (lineWidth(out) + lineWidth(piece) <= w) out.push(...piece);
  });
  return out;
}

function placeholder(state: State): string {
  switch (state.status) {
    case "working":
      return "Agents are working. You can write your next message now";
    case "cancelling":
      return "Cancelling…";
    case "deciding":
      return "Press a to apply, v to see the changes, or reply";
    default:
      return state.turn === 0 ? "Describe what you want done, or type / for commands" : "Reply, refine, or ask for something new";
  }
}

// ── full frame ───────────────────────────────────────────────────────────────

export function renderFrame(state: State, editor: Editor, width: number, height: number, ctx: ViewContext): Frame {
  const { theme } = ctx;
  const g = theme.glyphs;
  const L = computeLayout(state, width, height);

  if (width < 24 || height < 8) {
    const msg = truncateText("terminal too small for yxu", width);
    return { rows: [toAnsi(pad([s(msg, { fg: "amber" })], width), theme), ...Array.from({ length: height - 1 }, () => toAnsi(pad([], width), theme))] };
  }

  const headerRows: Line[] = [header(state, width, ctx), rule(width, g)];
  // The palette takes the decision box's place while it is open (the decision returns after).
  const palette = paletteRows(state, L.main, ctx);
  const decision = palette.length
    ? palette
    : state.approval
      ? approvalRows(state, L.main, ctx)
      : state.gate
        ? gateRows(state, L.main, ctx)
        : decisionRows(state, L.main, ctx);
  // The message box: rounded, lit while yxu is waiting for you, dim while it works.
  const busy = state.status === "working" || state.status === "cancelling";
  const boxW = Math.max(12, L.main - 2);
  const border: Style = { fg: busy ? "faint" : "cyan" };
  const input = inputRows(editor, boxW, 5); // "│ › " lead and " │" end
  const maxInput = Math.min(MAX_INPUT_ROWS, Math.max(1, Math.floor(height / 4)));
  const inputShown = Math.min(input.rows.length, maxInput);
  // Keep the cursor row visible when the draft is taller than the box.
  const inputStart = Math.max(0, Math.min(input.cursor.row - inputShown + 1, input.rows.length - inputShown));
  const inputBlock: Line[] = [];
  // Images waiting to go with the message, just above the box.
  if (state.attachments?.length) {
    const chips: Line = [s("  ")];
    for (const a of state.attachments) chips.push(s(`${g.image} `, { fg: "violet" }), s(a.name, { fg: "ivory" }), s(` ${a.bytes >= 1048576 ? `${(a.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.bytes / 1024))} KB`}   `, { fg: "faint" }));
    chips.push(s("/image clear removes", { fg: "faint" }));
    inputBlock.push(truncate(chips, L.main));
  }
  inputBlock.push([s(" "), s(g.rtl + g.h.repeat(boxW - 2) + g.rtr, border)]);
  const isEmpty = editor.isEmpty;
  for (let i = 0; i < inputShown; i++) {
    const text = input.rows[inputStart + i] ?? "";
    const lead = i === 0 && inputStart === 0 ? s(`${g.prompt} `, { fg: busy ? "faint" : "cyan", bold: true }) : s("  ");
    const content: Line = isEmpty && i === 0 ? [lead, s(placeholder(state), { fg: "faint" })] : [lead, s(text, { fg: "ivory" })];
    inputBlock.push([s(" "), s(`${g.v} `, border), ...pad(truncate(content, boxW - 4), boxW - 4), s(` ${g.v}`, border)]);
  }
  inputBlock.push([s(" "), s(g.rbl + g.h.repeat(boxW - 2) + g.rbr, border)]);
  // ui.footer: false hides the key hints (flash messages still show).
  const footer: Line[] = state.layout?.footer === false && !state.flash ? [] : [footerRow(state, width, ctx)];

  const bodyH = height - headerRows.length - decision.length - inputBlock.length - footer.length;
  const body: Line[] = [];

  if (state.helpOpen) {
    const all = helpRows(state, L.main, ctx);
    const off = Math.min(state.helpScroll ?? 0, Math.max(0, all.length - bodyH));
    body.push(...all.slice(off, off + bodyH));
  } else if (!state.entries.length) {
    body.push(...welcome(state, L.main, bodyH, ctx).slice(0, bodyH));
  } else {
    const { rows } = conversationRows(state, L.main - 1, ctx);
    const maxScroll = Math.max(0, rows.length - bodyH);
    const scroll = Math.min(state.scroll, maxScroll);
    const end = rows.length - scroll;
    const start = Math.max(0, end - bodyH);
    body.push(...rows.slice(start, end));
    if (scroll > 0 && body.length) {
      body[body.length - 1] = [s(` ${g.down} ${scroll} newer row${scroll === 1 ? "" : "s"} · end to follow`, { fg: "amber" })];
    }
    if (start > 0 && body.length && scroll > 0) {
      body[0] = [s(` ${g.up} ${start} earlier`, { fg: "faint" })];
    }
  }
  while (body.length < bodyH) body.push([]);

  const panel = L.panel ? panelRows(state, L.panel, bodyH + decision.length + inputBlock.length, ctx) : [];

  const out: string[] = [];
  const bgPanel: Style = { bg: "panel" };
  for (const r of headerRows) out.push(toAnsi(pad(r, width), theme));
  const mainRows = [...body, ...decision, ...inputBlock];
  mainRows.forEach((r, i) => {
    const main = pad(r, L.main);
    const side = L.panel ? pad(panel[i] ?? [s(` ${g.v} `, { fg: "faint", bg: "panel" })], L.panel, bgPanel) : [];
    out.push(toAnsi([...main, ...side], theme));
  });
  for (const r of footer) out.push(toAnsi(pad(r, width), theme));

  const cursorRow = headerRows.length + body.length + decision.length + (state.attachments?.length ? 2 : 1) + (input.cursor.row - inputStart);
  const cursor = state.helpOpen ? undefined : { row: cursorRow, col: 5 + input.cursor.col };
  return { rows: out.slice(0, height), cursor };
}
