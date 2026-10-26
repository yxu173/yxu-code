import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { which } from "../platform.ts";
import { applyTask, applyWithHooks, diffStat, discardTask, type ActionResult } from "../actions.ts";
import { hasHooks, withRunHooks } from "../hooks.ts";
import { describe, type Answer, type PermissionRequest } from "../permissions.ts";
import type { PluginCommand } from "../plugin-api.ts";
import { loadPlugins, pluginContext, setApproval, setPluginHost } from "../plugins.ts";
import { packStatus, type PackStatus } from "../pack-install.ts";
import { packContents } from "../packs.ts";
import { needsTrust, setTrust } from "../trust.ts";
import { readTaskRecord } from "../combine.ts";
import { getWorkflow, orchestratorLabel, type Config, type Workflow } from "../config.ts";
import { branchFor, excludeYxuDir, tryGit } from "../git.ts";
import { Session } from "../ops.ts";
import { runPipeline } from "../orchestrator/pipeline.ts";
import { Conversation, type TurnRecord } from "../conversation.ts";
import { ago, samePath, describe as describeSession, findSession, listSessions, newSession, restoreTasks, saveSession, tildePath, titleFrom, type SessionFile } from "../sessions.ts";
import { liveTask, liveTasks, onLiveChange, type LiveControl } from "../runner.ts";
import { buildRepoMap, loadRepoMap, mapSlice, overviewText, type RepoMap } from "../repomap.ts";
import { fixCi, type FixCiOptions, type FixCiResult } from "../fix-ci.ts";
import { issueGoal, resolveIssue } from "../github.ts";
import { openPr, tagIssue, tagRun, type OpenPrOptions } from "../pr.ts";
import type { IssueRef } from "../task-notes.ts";
import { compactConversation, runOrchestrator, type OrchestratorRender, type RunOutcome } from "../orchestrator/run.ts";
import { saveConfigPatch } from "../config-edit.ts";
import { display, FILE_LAYERS, LAYERS, loadLayers, originOf, type FileLayer } from "../config-layers.ts";
import { explainRows } from "../config-explain.ts";
import { allCommands, COMMANDS, findCommand, onOff, paletteFor, parseCommandLine } from "./commands.ts";
import { commandUsage, expandCommand, loadUserCommands, type UserCommand } from "../user-commands.ts";
import { runVerify } from "../verify.ts";
import { buildContextPrompt, worthCompacting, formatTokens, parseTokensArg, resolveInclude, type ContextUsage } from "../context.ts";
import { killAllSubagents } from "../runner.ts";
import type { TaskResult } from "../types.ts";
import { Editor } from "./editor.ts";
import { KeyParser, type Key } from "./keys.ts";
import { Store, type ContextInfo, type Entry, type TaskView } from "./model.ts";
import { recoveryHint } from "./recovery.ts";
import { createTheme, type Glyphs, type Palette, type Theme } from "./theme.ts";
import { BUILTIN_THEMES, loadTheme, themeFileMap } from "./themes.ts";
import { buildKeymap, KEY_ACTIONS, translateKey, type KeyAction, type Keymap } from "../keymap.ts";
import { catalogKey, keyLabel, ModelCatalog } from "../models.ts";
import type { CliName } from "../types.ts";
import { computeLayout, conversationRows, renderFrame, type Frame } from "./view.ts";

type Activity = Extract<Entry, { kind: "activity" }>;

/** How the UI starts a run. Production wraps runOrchestrator/runPipeline; tests and demo inject fakes. */
export interface Engine {
  run(opts: {
    goal: string;
    workflow: Workflow & { name: string };
    render: OrchestratorRender;
    abort: AbortController;
    session: Session;
    resume?: string;
    /** Text before the goal: what happened since a background summary that `resume` points at. */
    preamble?: string;
    /** The conversation as yxu recorded it (rebuilds memory if `resume` is gone). */
    history?: TurnRecord[];
    /** The live config (context/compact settings can change during a session). */
    cfg: Config;
    /** Pipeline inputs (from /run or a command). */
    inputs?: Record<string, string>;
    /** Ask the user at a workflow gate. */
    gate?: (message: string, stepId: string) => Promise<boolean>;
  }): Promise<RunOutcome>;
  /** Summarize the remembered orchestrator conversation now. Optional: not every engine can. */
  compact?(opts: { cfg: Config; sessionId: string; instructions?: string; abort: AbortController; render: OrchestratorRender; fork?: boolean }): Promise<CompactResult>;
}

export type CompactResult = Awaited<ReturnType<typeof compactConversation>>;

/** Git-side operations on task results. Swappable so tests and the demo never touch real branches. */
export interface TaskBackend {
  exists(id: string): boolean;
  diff(id: string): string;
  apply(id: string): ActionResult | Promise<ActionResult>;
  discard(id: string): ReturnType<typeof discardTask>;
  /** GitHub (or plugin trackers): issues in, pull requests out, CI fixes. */
  github?: {
    issue(ref: string): Promise<{ goal: string; issue: IssueRef }>;
    pullRequest(id: string, o: OpenPrOptions): string;
    fixCi(pr: string, o: Omit<FixCiOptions, "print"> & { print: (l: string) => void }): Promise<FixCiResult>;
  };
}

export function gitBackend(root: string, cfg: () => Config): TaskBackend {
  return {
    exists: (id) => !!tryGit(root, "branch", "--list", branchFor(id)).out,
    diff: (id) => {
      const r = tryGit(root, "diff", `HEAD...${branchFor(id)}`);
      return (r.ok && r.out) || readTaskRecord(root, id)?.diff || "";
    },
    apply: (id) => (hasHooks(cfg(), "before_apply") ? applyWithHooks(cfg(), root, id) : applyTask(root, id)),
    discard: (id) => discardTask(root, id),
    github: {
      issue: async (ref) => {
        const [r, ...extra] = ref.split(/\s+/);
        const issue = await resolveIssue(root, cfg(), r!);
        return { goal: issueGoal(root, issue, extra.join(" ")), issue };
      },
      pullRequest: (id, o) => openPr(root, id, o),
      fixCi: (pr, o) => fixCi(root, cfg(), pr, o),
    },
  };
}

export function productionEngine(root: string): Engine {
  return {
    run: ({ goal, workflow, render, abort, session, resume, preamble, history, cfg, inputs, gate }) =>
      withRunHooks(cfg, root, { goal, workflow: workflow.name, session, signal: abort.signal }, () =>
        workflow.mode === "pipeline"
          ? runPipeline({ goal, cfg, workflow, root, render, abort, session, inputs, gate })
          : runOrchestrator({ goal, cfg, workflow, root, render, abort, session, resume, preamble, history }),
      ),
    compact: ({ cfg, sessionId, instructions, abort, render, fork }) => compactConversation({ cfg, root, sessionId, instructions, abort, render, fork }),
  };
}

export interface AppOptions {
  cfg: Config;
  root: string;
  theme: Theme;
  engine: Engine;
  workflow?: string;
  demo?: boolean;
  /** Where frames go. The real terminal in production; a buffer in tests. */
  draw: (frame: Frame) => void;
  size: () => { width: number; height: number };
  /** Called when the user exits. */
  exit: (summary: { pending: { taskId: string; agent: string }[] }) => void;
  invalidate?: () => void;
  historyFile?: string | null;
  backend?: TaskBackend;
  /** Model lists per agent CLI (defaults to querying the CLIs, cached for a day). */
  catalog?: ModelCatalog;
  /** --set overrides the config was loaded with. */
  sets?: string[];
  /** A saved session to continue (yxu resume, yxu -c). */
  resume?: SessionFile;
  /** Where yxu was started (default: the repo root). Recorded with the session. */
  folder?: string;
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const HOOKED_TOOLS = new Set(["delegate", "combine", "discard", "verify", "StructuredOutput", "delegate_parallel"]);

export class App {
  readonly store: Store;
  readonly editor: Editor;
  private parser = new KeyParser();
  private workflow: Workflow & { name: string };
  private session = new Session();
  /** The remembered orchestrator conversation, and summaries made of it in the background. */
  private conv = new Conversation();
  /** This session as saved in ~/.local/share/yxu/sessions (after each turn). */
  private saved!: SessionFile;
  private get sdkSessionId(): string | undefined {
    return this.conv.sessionId;
  }
  /** Background compaction in progress (between turns). */
  private bgCompact?: { abort: AbortController; done: Promise<void> };
  private abort?: AbortController;
  private streaming?: Extract<Entry, { kind: "assistant" }>;
  private openRead?: Activity;
  private tick = 0;
  private ticker?: ReturnType<typeof setInterval>;
  private renderQueued = false;
  private lastTotalRows = 0;
  private exitArmed = false;
  private flashTimer?: ReturnType<typeof setTimeout>;
  private escTimer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private backend: TaskBackend;
  /** Live config: a copy the user can adjust with slash commands. */
  readonly cfg: Config;
  /** Interface theme (ascii / motion can change at runtime). */
  theme: Theme;
  /** Which models each agent CLI offers. */
  readonly catalog: ModelCatalog;
  /** Setting changes made this session, keyed by yaml path; written by /save. */
  private dirty = new Map<string, { path: string[]; value: unknown }>();

  constructor(private readonly o: AppOptions) {
    this.cfg = structuredClone(o.cfg);
    Object.defineProperty(this.cfg, "plugins", { value: o.cfg.plugins, enumerable: false, writable: true });
    this.theme = o.theme;
    this.catalog = o.catalog ?? new ModelCatalog();
    // When a model list arrives, refresh an open palette that is waiting for it.
    this.catalog.onChange(() => {
      if (this.store.state.palette) this.updatePalette();
    });
    this.workflow = getWorkflow(this.cfg, o.workflow);
    this.backend = o.backend ?? gitBackend(o.root, () => this.cfg);
    this.store = new Store(this.contextInfo(), { demo: o.demo, panelOpen: true });
    this.editor = new Editor(this.loadHistory());
    this.store.subscribe(() => this.requestRender());
    if (!o.demo) this.refreshMap();
    this.saved = newSession(o.root, o.folder ?? o.root, this.conv.state);
    if (o.resume) this.openSession(o.resume);
    const ui = this.cfg.ui;
    this.store.set({ panelOpen: ui.panel, layout: { sections: ui.panel_sections, footer: ui.footer } });
    try {
      this.keymap = buildKeymap(ui.keys);
    } catch (e) {
      this.fail((e as Error).message, "using the default keys");
    }
    if (ui.theme !== o.theme.name) this.switchTheme(ui.theme, true);
    if (!o.demo) {
      this.reloadUserCommands();
      this.announceTrust();
      this.startPlugins();
    }
  }

  /** In a repo the user hasn't trusted, say once what its config would run. */
  private announceTrust() {
    const items = needsTrust(this.cfg);
    const shell = this.userCommands.filter((c) => c.scope === "project" && c.kind === "shell").map((c) => `/${c.name}`);
    if (this.cfg.trusted !== false || (!items.length && !shell.length)) return;
    const list = [...items, ...(shell.length ? [`shell commands ${shell.join(", ")}`] : [])];
    this.store.add({
      kind: "notice",
      tone: "attention",
      text: `**This repository is not trusted.** Its config wants to run:\n${list.map((i) => `- ${i}`).join("\n")}\n\nThose stay off until you trust it with /trust. Agents and everything else work as usual.`,
    });
  }

  /** `/trust [off]`: trust this repo (commands from its config may run), or take it back. */
  trustRepo(off = false) {
    setTrust(this.o.root, !off);
    this.cfg.trusted = !off;
    this.note(off ? "This repository is no longer trusted; commands from its config won't run." : "Trusted this repository: commands from its config (hooks, steps, agent commands) may run now.", off ? "attention" : "ok");
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  render() {
    this.renderQueued = false;
    const { width, height } = this.o.size();
    const ctx = { theme: this.theme, tick: this.tick, now: Date.now() };
    // Keep the viewport anchored when new rows arrive while scrolled up.
    const L = computeLayout(this.store.state, width, height);
    const total = conversationRows(this.store.state, L.main - 1, ctx).rows.length;
    if (this.store.state.scroll > 0 && total > this.lastTotalRows) this.store.state.scroll += total - this.lastTotalRows;
    this.lastTotalRows = total;
    this.o.draw(renderFrame(this.store.state, this.editor, width, height, ctx));
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setTimeout(() => this.render(), 12);
  }

  /** Feed raw terminal input. */
  input(chunk: string) {
    for (const k of this.parser.feed(chunk)) this.key(k);
    clearTimeout(this.escTimer);
    this.escTimer = setTimeout(() => {
      for (const k of this.parser.flush()) this.key(k);
    }, 40);
  }

  /** The task session shared across turns (read-only use by backends). */
  get taskSession(): Session {
    return this.session;
  }

  /** Wait for the current run to settle (tests). */
  async idle() {
    await this.running;
  }

  dispose() {
    for (const t of this.panelTimers) clearInterval(t);
    clearInterval(this.ticker);
    clearTimeout(this.flashTimer);
    clearTimeout(this.escTimer);
    this.abort?.abort();
    this.stopBackgroundCompaction();
    this.stopWatching();
  }

  // ── keys ───────────────────────────────────────────────────────────────────

  private paletteDismissed = false;

  key(raw: Key) {
    const st = this.store.state;
    const k = translateKey(raw, this.keymap, { moment: st.gate ? "gate" : st.status === "deciding" ? "decision" : "always", draftEmpty: this.editor.isEmpty });
    if (!k) return;
    if (this.paletteKey(k)) return;
    const before = this.editor.text;
    this.keyInner(k);
    if (this.editor.text !== before) {
      this.paletteDismissed = false;
      this.updatePalette();
    }
  }

  /** Recompute the slash-command palette for the current draft. */
  updatePalette() {
    const p = this.paletteDismissed || this.store.state.helpOpen ? undefined : paletteFor(this, this.editor.text);
    // Typing re-filters, so the best match is selected again (arrows move from there).
    this.store.set({ palette: p });
  }

  /** Keys the palette handles while it is open. Returns true when consumed. */
  private paletteKey(k: Key): boolean {
    const p = this.store.state.palette;
    if (!p) return false;
    const n = p.items.length;
    switch (k.name) {
      case "up":
      case "down":
        if (!n || k.ctrl || k.shift) return false;
        p.selected = (p.selected + (k.name === "up" ? -1 : 1) + n) % n;
        this.store.changed();
        return true;
      case "tab":
        if (!n) return true;
        this.acceptSuggestion(false);
        return true;
      case "enter":
        if (!n) return false; // nothing to complete: submit what was typed
        this.acceptSuggestion(true);
        return true;
      case "escape":
        this.paletteDismissed = true;
        this.store.set({ palette: undefined });
        return true;
      default:
        return false;
    }
  }

  /** Put the selected suggestion into the draft; on Enter, run it when nothing more is needed. */
  private acceptSuggestion(run: boolean) {
    const p = this.store.state.palette!;
    const item = p.items[p.selected]!;
    const text = this.editor.text;
    const cut = text.search(/\S+$/);
    const head = p.mode === "command" ? "/" : cut >= 0 ? text.slice(0, cut) : text;
    const typedToken = p.mode === "command" ? text.slice(1) : cut >= 0 ? text.slice(cut) : "";
    const next = head + item.value;
    const cmd = findCommand(p.mode === "command" ? item.value : (p.command ?? ""), this);
    // Will another argument follow? (the palette has suggestions for the next position)
    const more = !!cmd && (paletteFor(this, `${next} `)?.items.length ?? 0) > 0;
    const needsArg = p.mode === "command" && !!cmd?.needsArgs;
    this.editor.setText(next);
    const complete = typedToken === item.value;
    if (run && (complete || (!more && !needsArg))) {
      this.store.set({ palette: undefined });
      this.submit();
      this.updatePalette();
      return;
    }
    if (more || needsArg) this.editor.insert(" ");
    this.updatePalette();
  }

  private keyInner(k: Key) {
    const st = this.store.state;
    const e = this.editor;
    const working = st.status === "working" || st.status === "cancelling";

    if (st.helpOpen) {
      const step = { up: -1, down: 1, pageup: -10, pagedown: 10 }[k.name as string];
      if (step) return this.store.set({ helpScroll: Math.max(0, (st.helpScroll ?? 0) + step) });
      if (k.name === "home") return this.store.set({ helpScroll: 0 });
      if (k.name === "escape" || (k.name === "char" && k.text === "?") || k.name === "enter") this.store.set({ helpOpen: false, helpScroll: 0 });
      else if (k.name === "char" && k.ctrl && k.text === "c") this.store.set({ helpOpen: false, helpScroll: 0 });
      return;
    }

    if (k.name === "char" && k.ctrl && !k.alt) {
      switch (k.text) {
        case "c":
          if (working) return this.cancel();
          if (!e.isEmpty) {
            e.clear();
            return this.store.changed();
          }
          if (this.exitArmed) return this.quit();
          this.exitArmed = true;
          this.flash("press ctrl+c again to exit", 2000, () => (this.exitArmed = false));
          return;
        case "d":
          if (e.isEmpty && !working) return this.quit();
          e.delete();
          return this.store.changed();
        case "p":
          return this.store.set({ panelOpen: !st.panelOpen });
        case "o":
          return this.toggleDetails();
        case "l":
          this.o.invalidate?.();
          return this.render();
        case "j":
          e.newline();
          return this.store.changed();
        case "a":
          e.home();
          return this.store.changed();
        case "e":
          e.end();
          return this.store.changed();
        case "u":
          e.killToStart();
          return this.store.changed();
        case "k":
          e.killToEnd();
          return this.store.changed();
        case "w":
          e.deleteWord();
          return this.store.changed();
      }
      return;
    }

    // An approval waits for y (once) / a (always this session) / n (deny).
    if (st.approval && e.isEmpty) {
      const t = k.name === "char" && !k.ctrl && !k.alt ? k.text?.toLowerCase() : undefined;
      if (t === "y") return this.answerApproval("once");
      if (t === "a") return this.answerApproval("always");
      if (t === "n" || k.name === "escape") return this.answerApproval("deny");
    }

    // A gate waits for y/n (enter continues, esc stops) while the draft is empty.
    if (st.gate && e.isEmpty) {
      const t = k.name === "char" && !k.ctrl && !k.alt ? k.text?.toLowerCase() : undefined;
      if (t === "y" || k.name === "enter") return this.answerGate(true);
      if (t === "n" || k.name === "escape") return this.answerGate(false);
    }

    // Decision keys act only when the draft is empty, so typing a follow-up still works.
    if (st.status === "deciding" && e.isEmpty && k.name === "char" && !k.ctrl && !k.alt) {
      const t = k.text?.toLowerCase();
      if (t === "a") return void this.decide("apply");
      if (t === "v") return void this.decide("view");
      if (t === "l") return void this.decide("later");
      if (t === "x") return void this.decide("discard");
      if (t === "p") return void this.decide("pr");
    }

    switch (k.name) {
      case "escape":
        if (working) return this.cancel();
        if (st.status === "deciding") return void this.decide("later");
        if (st.selected !== undefined) return this.store.set({ selected: undefined });
        return;
      case "enter":
        return this.submit();
      case "newline":
        e.newline();
        break;
      case "paste":
        e.insert(k.text ?? "");
        break;
      case "backspace":
        if (k.alt || k.ctrl) e.deleteWord();
        else e.backspace();
        break;
      case "delete":
        e.delete();
        break;
      case "left":
        if (k.ctrl || k.alt) e.wordLeft();
        else e.left();
        break;
      case "right":
        if (k.ctrl || k.alt) e.wordRight();
        else e.right();
        break;
      case "up":
        if (k.ctrl) return this.select(-1);
        if (k.shift) return this.scrollBy(3);
        e.up();
        break;
      case "down":
        if (k.ctrl) return this.select(1);
        if (k.shift) return this.scrollBy(-3);
        e.down();
        break;
      case "home":
        if (k.ctrl) return this.scrollTo(Number.MAX_SAFE_INTEGER);
        e.home();
        break;
      case "end":
        if (k.ctrl || e.isEmpty) return this.scrollTo(0);
        e.end();
        break;
      case "pageup":
        return this.scrollBy(this.page());
      case "pagedown":
        return this.scrollBy(-this.page());
      case "tab":
        e.insert("  ");
        break;
      case "char":
        if (k.alt && k.text === "b") e.wordLeft();
        else if (k.alt && k.text === "f") e.wordRight();
        else if (!k.alt && k.text === "?" && e.isEmpty) return this.store.set({ helpOpen: true });
        else if (!k.alt) e.insert(k.text ?? "");
        break;
      default:
        return;
    }
    this.store.changed();
  }

  private page(): number {
    return Math.max(3, this.o.size().height - 10);
  }

  private scrollBy(n: number) {
    this.scrollTo(Math.max(0, this.store.state.scroll + n));
  }

  private scrollTo(n: number) {
    const { width, height } = this.o.size();
    const L = computeLayout(this.store.state, width, height);
    const total = conversationRows(this.store.state, L.main - 1, { theme: this.theme, tick: this.tick, now: Date.now() }).rows.length;
    this.store.set({ scroll: Math.max(0, Math.min(n, Math.max(0, total - 3))) });
  }

  private select(dir: -1 | 1) {
    const acts = this.store.activities();
    if (!acts.length) return;
    const cur = acts.findIndex((a) => a.id === this.store.state.selected);
    let next = cur === -1 ? (dir === -1 ? acts.length - 1 : -1) : cur + dir;
    if (next < 0) next = 0;
    if (next >= acts.length) return this.store.set({ selected: undefined, scroll: 0 });
    const target = acts[next]!;
    this.store.set({ selected: target.id });
    this.reveal(target.id);
  }

  /** Scroll so an entry's first row is visible. */
  private reveal(id: number) {
    const { width, height } = this.o.size();
    const L = computeLayout(this.store.state, width, height);
    const { rows, starts } = conversationRows(this.store.state, L.main - 1, { theme: this.theme, tick: this.tick, now: Date.now() });
    const start = starts.get(id);
    if (start === undefined) return;
    const bodyH = Math.max(3, height - 8);
    const viewEnd = rows.length - this.store.state.scroll;
    const viewStart = viewEnd - bodyH;
    if (start < viewStart + 1) this.store.set({ scroll: Math.max(0, rows.length - start - bodyH + 2) });
    else if (start >= viewEnd - 1) this.store.set({ scroll: Math.max(0, rows.length - start - 3) });
  }

  private toggleDetails() {
    const acts = this.store.activities().filter((a) => a.details.length);
    const target = acts.find((a) => a.id === this.store.state.selected) ?? acts.at(-1);
    if (!target) return this.flash("no activity with details yet", 1500);
    this.store.update(target, { expanded: !target.expanded });
    if (target.expanded) this.reveal(target.id);
  }

  private flash(msg: string, ms: number, after?: () => void) {
    clearTimeout(this.flashTimer);
    this.store.set({ flash: msg });
    this.flashTimer = setTimeout(() => {
      this.store.set({ flash: undefined });
      after?.();
    }, ms);
  }

  // ── submit / commands ──────────────────────────────────────────────────────

  submit() {
    const text = this.editor.text;
    const st = this.store.state;
    if (!text.trim()) return;
    // Slash commands work at any time (settings apply to the next run); goals wait for the current one.
    if (text.trim().startsWith("/")) {
      this.editor.commit(text);
      this.saveHistory(text);
      this.store.set({ scroll: 0, palette: undefined });
      if (st.status === "deciding" && !/^\/(diff|apply|discard)\b/.test(text.trim())) this.clearDecision(true);
      return void this.runCommand(text.trim());
    }
    if (st.status === "working" || st.status === "cancelling") {
      this.flash("an operation is running — esc cancels it; your draft is kept", 2500);
      return;
    }
    this.editor.commit(text);
    this.saveHistory(text);
    this.store.set({ scroll: 0, selected: undefined });
    if (st.status === "deciding") this.clearDecision(true);
    if (text.trim().startsWith("/")) return void this.runCommand(text.trim());
    if (text.trim() === "?") return this.store.set({ helpOpen: true });
    this.running = this.startRun(text.trim());
  }

  /** Run a slash command line via the registry. */
  runCommand(line: string) {
    const { name, args } = parseCommandLine(line);
    const cmd = findCommand(name, this);
    if (!cmd) {
      const shared = (c: string) => [...name].findIndex((ch, i) => c[i] !== ch) >>> 0; // common prefix length
      const near = allCommands(this).filter((c) => c.name.startsWith(name.slice(0, 2)))
        .sort((a, b) => Math.min(shared(b.name), name.length) - Math.min(shared(a.name), name.length))
        .map((c) => `/${c.name}`)
        .slice(0, 4);
      return this.fail(`unknown command /${name}`, near.length ? `did you mean ${near.join(", ")}? Type / to browse commands` : "type / to browse commands");
    }
    try {
      const r = cmd.run(this, args);
      if (r instanceof Promise) r.catch((e) => this.fail(`/${cmd.name} failed: ${(e as Error).message}`));
    } catch (e) {
      this.fail(`/${cmd.name} failed: ${(e as Error).message}`);
    }
  }

  // ── command API (used by commands.ts) ──────────────────────────────────────

  get root(): string {
    return this.o.root;
  }

  note(text: string, tone: "memory" | "info" | "ok" | "attention" = "memory") {
    this.store.add({ kind: "notice", tone, text });
  }

  fail(message: string, hint?: string) {
    this.store.add({ kind: "error", message, hint });
  }

  /** A setting changed for this session: refresh the panel and say how to keep it. */
  changed(what: string) {
    this.refreshContext(what);
  }

  /** Set a config value for this session and remember it for /save (yamlValue: how to write it). */
  setConfig(path: string[], value: unknown, yamlValue: unknown = value) {
    let obj = this.cfg as unknown as Record<string, unknown>;
    for (const k of path.slice(0, -1)) obj = (obj[k] ??= {}) as Record<string, unknown>;
    const last = path.at(-1)!;
    if (value === undefined) delete obj[last];
    else obj[last] = value;
    // Replacing a whole section (e.g. removing an agent) supersedes earlier changes inside it.
    const key = path.join(".");
    for (const k of this.dirty.keys()) if (k.startsWith(`${key}.`)) this.dirty.delete(k);
    this.dirty.delete(key);
    this.dirty.set(key, { path, value: yamlValue });
    this.store.set({ context: this.contextInfo() });
  }

  /** Write this session's changes to one config layer (default: the project's yxu.yaml). */
  saveConfig(target = "project") {
    const layer = target.replace(/^--/, "") as FileLayer;
    if (!(FILE_LAYERS as readonly string[]).includes(layer)) {
      return this.fail(`unknown layer "${target}"`, "save to: user (~/.config/yxu) · project (yxu.yaml) · local (yxu.local.yaml, git-ignored)");
    }
    if (!this.dirty.size) return this.note("Nothing to save: no settings changed this session.", "info");
    try {
      const saved = [...this.dirty.values()];
      const file = saveConfigPatch(this.o.root, saved, layer);
      this.dirty.clear();
      const lines = [`Saved ${saved.length} setting${saved.length === 1 ? "" : "s"} to ${display(file, this.o.root)} (${layer}).`];
      // A higher layer still decides some of these: say so instead of silently "saving" them.
      const loaded = loadLayers(this.o.root, { sets: this.o.sets });
      for (const { path } of saved) {
        const o = originOf(loaded, path.join("."), this.o.root);
        if (LAYERS.indexOf(o.layer) > LAYERS.indexOf(layer)) lines.push(`- \`${path.join(".")}\` is still overridden by ${o.file ?? o.layer}`);
      }
      this.note(lines.join("\n"), lines.length > 1 ? "attention" : "ok");
    } catch (e) {
      this.fail((e as Error).message, "nothing was written; fix the value and /save again");
    }
  }

  /** `/config [key]`: where each setting comes from. */
  explainConfig(key?: string) {
    try {
      const loaded = loadLayers(this.o.root, { sets: this.o.sets });
      const files = loaded.layers.filter((l) => l.file).map((l) => `- ${l.pack ? `pack ${l.pack}` : l.name}: ${display(l.file!, this.o.root)}${l.exists ? "" : " (none)"}`);
      const rows = explainRows(loaded, this.o.root, key);
      if (key && !rows.length) return this.fail(`no setting "${key}"`, "try /config with no key to list everything");
      const unsaved = this.dirty.size ? [`*${this.dirty.size} unsaved session change${this.dirty.size === 1 ? "" : "s"} (not shown) — /save [user|project|local]*`] : [];
      this.note(["**Config layers** (later wins)", ...files, "", ...rows.map((r) => `- \`${r.key}\` = ${r.value} · ${r.from}`), ...unsaved].join("\n"));
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  private themeLook: { palette?: Palette; glyphs?: Partial<Glyphs> } = {};

  setTheme(opts: { ascii?: boolean; reducedMotion?: boolean }) {
    this.theme = createTheme({
      ...this.themeLook,
      depth: this.theme.depth,
      ascii: opts.ascii ?? this.theme.ascii,
      reducedMotion: opts.reducedMotion ?? this.theme.reducedMotion,
      paintBackground: this.theme.paintBackground,
    });
    this.o.invalidate?.();
    this.store.changed();
  }

  /** `/theme <name>`: switch colors now (and /save keeps it in ui.theme). */
  switchTheme(name: string, quiet = false) {
    try {
      const t = loadTheme(name, this.o.root);
      this.themeLook = { palette: t.palette, glyphs: t.glyphs };
    } catch (e) {
      return this.fail((e as Error).message, "type /theme to list themes");
    }
    this.setTheme({});
    if (quiet) return;
    this.setConfig(["ui", "theme"], name);
    this.note(`Theme ${name}${this.theme.depth === "none" ? " (colors are off in this terminal)" : ""} — for this session; /save keeps it.`);
  }

  listThemes() {
    const files = themeFileMap(this.o.root);
    this.note(
      [
        `**Themes** (current: ${this.theme.name})`,
        ...Object.entries(BUILTIN_THEMES).map(([n, t]) => `- \`${n}\` — ${t.about}`),
        ...[...files].map(([n, f]) => `- \`${n}\` — ${display(f, this.o.root)}`),
        "",
        "Make your own: ~/.config/yxu/themes/<name>.yaml with `extends:` and `colors:` (#rrggbb per role).",
      ].join("\n"),
    );
  }

  /** The effective key bindings. */
  keymap: Keymap = buildKeymap();

  showKeys() {
    const rows = Object.entries(this.keymap.bindings).map(([a, spec]) => {
      const changed = spec !== KEY_ACTIONS[a as KeyAction].key;
      return `- \`${spec}\` ${a}${changed ? " *(yours)*" : ""} — ${KEY_ACTIONS[a as KeyAction].about}`;
    });
    this.note(["**Keys** (rebind with `ui.keys` in your config, e.g. `panel: ctrl+b`)", ...rows, ...this.keymap.warnings.map((w) => `- ⚠ ${w}`)].join("\n"));
  }

  /** Forget the remembered orchestrator conversation (next message starts fresh). */
  resetConversation() {
    this.stopBackgroundCompaction();
    this.conv.reset();
    this.saved = newSession(this.o.root, this.o.folder ?? this.o.root, this.conv.state);
    this.store.set({ remembering: false });
  }

  newConversation() {
    this.resetConversation();
    this.store.add({ kind: "divider", label: "new conversation" });
  }

  clearView() {
    this.lastTotalRows = 0;
    this.store.set({ entries: [], scroll: 0, selected: undefined });
  }

  listAgents() {
    const lines = Object.entries(this.cfg.agents).map(([n, a]) => {
      const bits = [a.cli, a.model, a.permission === "plan" ? "read-only" : (a.permission ?? "accept-edits"), a.timeout ? `timeout ${Math.round(a.timeout / 60000)}m` : "", a.max_turns ? `${a.max_turns} turns` : ""].filter(Boolean);
      return `- **${n}** — ${bits.join(" · ")}${a.description ? `. ${a.description}` : ""}`;
    });
    this.note(`Agents (up to ${this.cfg.settings.concurrency} at once${this.cfg.settings.resolver ? `, resolver ${this.cfg.settings.resolver}` : ""}):\n${lines.join("\n")}\n\nChange one with \`/agent <name> model|cli|role|instructions|permission|timeout|turns <value>\`, add one with \`/agent new <name> <cli> [model]\`, remove one with \`/agent remove <name>\`. \`/save\` keeps changes.`);
  }

  listTasks() {
    const ts = this.store.state.tasks;
    this.note(ts.length ? ts.map((t) => `${t.taskId}  ${t.agent}  ${t.pending ? "pending" : t.state}  ${t.title}`).join("\n") : "No tasks in this session yet.");
  }

  taskAction(kind: "diff" | "apply" | "discard", arg?: string) {
    const id = this.resolveTask(arg ?? "");
    if (!id) return this.fail(arg ? `no task matching "${arg}"` : `/${kind} needs a task id`, "type /tasks to list task ids");
    if (kind === "diff") return this.showDiff(id);
    if (kind === "apply") return void this.applyTask(id);
    return this.discardTask(id);
  }

  switchWorkflow(name: string) {
    if (!name) {
      const names = Object.keys(this.cfg.workflows);
      const list = names.length ? names.map((n) => `${n === this.workflow.name ? "▸" : " "} ${n} (${this.cfg.workflows[n]!.mode})`).join("\n") : "(none configured; using default auto mode)";
      return this.note(`Workflow: ${this.workflow.name}\n${list}`);
    }
    try {
      this.workflow = getWorkflow(this.cfg, name);
    } catch (e) {
      return this.fail((e as Error).message, "type /workflow to list workflows");
    }
    this.resetConversation();
    this.store.set({ context: this.contextInfo() });
    this.note(`Workflow is now ${this.workflow.name} (${this.workflow.mode}). The next message starts a fresh conversation.`);
  }

  /** Start loading model lists for the CLIs this config uses (background, cached). */
  prefetchModels() {
    const keys = new Set(Object.values(this.cfg.agents).map(catalogKey));
    for (const key of keys) this.catalog.get(key);
  }

  async showModels(args: string[]): Promise<void> {
    const [target, ...rest] = args;
    const clis: CliName[] = ["commandcode", "opencode", "claude"];
    if (target === "refresh") {
      const used = [...new Set(Object.values(this.cfg.agents).map(catalogKey))];
      this.note(`Asking ${used.map(keyLabel).join(", ")} for their models…`, "info");
      await Promise.all(used.map((c) => this.catalog.refresh(c)));
      return this.showModels([]);
    }
    if (!target) {
      const lines = clis.map((c) => {
        const st = this.catalog.get(c);
        const users = Object.entries(this.cfg.agents).filter(([, a]) => a.cli === c).map(([n]) => n);
        const groups = [...new Set(st.models.map((m) => m.group))];
        const state =
          st.status === "loading" ? "loading…" : st.status === "error" ? `error: ${st.error}` : `${st.models.length} models${groups.length ? ` (${groups.slice(0, 8).join(", ")}${groups.length > 8 ? ", …" : ""})` : ""}`;
        return `- **${c}** — ${state}${users.length ? ` · used by ${users.join(", ")}` : ""}`;
      });
      return this.note(`Models by CLI\n${lines.join("\n")}\n\nList one with \`/models <agent|cli> [search]\`; pick with \`/agent <name> model\` (type to search, e.g. free, flash, 1m).`);
    }
    const agentDef = this.cfg.agents[target];
    const cli: string | undefined = (clis as string[]).includes(target) ? target : agentDef ? catalogKey(agentDef) : undefined;
    if (!cli) return this.fail(`unknown agent or CLI "${target}"`, "try /models opencode, /models commandcode, or an agent name");
    const st = this.catalog.get(cli);
    if (st.status === "loading" && !st.models.length) {
      await this.catalog.refresh(cli);
      return this.showModels(args);
    }
    if (st.status === "error" && !st.models.length) return this.fail(`could not list ${cli} models: ${st.error}`, "check yxu doctor, then /models refresh");
    const q = rest.join(" ").toLowerCase();
    const hits = st.models.filter((m) => !q || `${m.id} ${m.group} ${m.description}`.toLowerCase().includes(q));
    const byGroup = new Map<string, typeof hits>();
    for (const m of hits) byGroup.set(m.group, [...(byGroup.get(m.group) ?? []), m]);
    const PER_GROUP = q ? 40 : 12;
    const out: string[] = [`**${keyLabel(cli)}** — ${hits.length}${q ? ` of ${st.models.length}` : ""} models${q ? ` matching "${q}"` : ""}`];
    for (const [g, ms] of byGroup) {
      out.push("", `**${g || "models"}** (${ms.length})`);
      for (const m of ms.slice(0, PER_GROUP)) out.push(`- \`${m.id}\`${m.description ? ` — ${m.description}` : ""}${m.isDefault ? " (default)" : ""}`);
      if (ms.length > PER_GROUP) out.push(`- … ${ms.length - PER_GROUP} more — narrow with /models ${target} <search>`);
    }
    if (!hits.length) out.push("", "No matches.");
    this.note(out.join("\n"));
  }

  showStatus() {
    const c = this.cfg;
    const u = this.store.state.usage;
    const st = this.store.state;
    this.note(
      [
        "**Session**",
        `- workflow ${this.workflow.name} (${this.workflow.mode}) · orchestrator ${c.orchestrator.model}${c.orchestrator.effort ? ` · effort ${c.orchestrator.effort}` : ""} · budget ${c.orchestrator.max_budget_usd !== undefined ? `$${c.orchestrator.max_budget_usd}` : "none"}`,
        `- agents ${Object.keys(c.agents).length} · concurrency ${c.settings.concurrency} · resolver ${c.settings.resolver ?? "none"} · verify ${c.settings.verify ? `\`${c.settings.verify}\`` : "none"}`,
        `- memory ${c.context.memory ? (st.remembering ? `continuing (turn ${st.turn})` : "on") : "off"}${u ? ` · context ${formatTokens(u.tokens)}/${formatTokens(u.max)} (${Math.round(u.percentage)}%)` : ""} · auto-compact ${c.compact.auto ? "on" : "off"}`,
        `- cost: orchestrator $${st.cost.orchestrator.toFixed(4)} · agents $${st.cost.subagents.toFixed(4)}`,
        `- ${this.dirty.size ? `${this.dirty.size} unsaved setting change${this.dirty.size === 1 ? "" : "s"} — /save to keep` : "no unsaved setting changes"} · config ${c.source}`,
      ].join("\n"),
    );
  }

  // ── context & compaction ───────────────────────────────────────────────────

  private refreshContext(note?: string) {
    this.store.set({ context: this.contextInfo() });
    if (note) this.store.add({ kind: "notice", tone: "memory", text: `${note} — for this session; /save keeps it in yxu.yaml (/save local: only for you).` });
  }

  contextCommand(args: string[]) {
    const s = this.store;
    const c = this.cfg.context;
    const [sub, ...rest] = args;
    const value = rest.join(" ").trim();
    switch (sub) {
      case undefined:
      case "":
      case "show":
        s.add({ kind: "notice", tone: "memory", text: this.contextReport() });
        return;
      case "memory": {
        const v = onOff(rest[0]);
        if (v === undefined) return void s.add({ kind: "error", message: "usage: /context memory on|off" });
        this.setConfig(["context", "memory"], v);
        if (!v) this.resetConversation();
        return this.refreshContext(v ? "Memory on: messages continue the same orchestrator conversation" : "Memory off: each message starts a fresh orchestrator conversation");
      }
      case "instructions": {
        const v = onOff(rest[0]);
        if (v === undefined) return void s.add({ kind: "error", message: "usage: /context instructions on|off  (loads CLAUDE.md)" });
        this.setConfig(["context", "project_instructions"], v);
        return this.refreshContext(`Project instructions (CLAUDE.md) ${v ? "loaded" : "not loaded"} from the next message`);
      }
      case "add": {
        if (!value) return void s.add({ kind: "error", message: "usage: /context add <file>" });
        const abs = resolveInclude(this.o.root, value);
        if (!abs) return void s.add({ kind: "error", message: `${value} is outside the repository`, hint: "only files inside the repo can be added" });
        if (!existsSync(abs)) return void s.add({ kind: "error", message: `${value} does not exist`, hint: "paths are relative to the repository root" });
        if (!c.include.includes(value)) this.setConfig(["context", "include"], [...c.include, value]);
        return this.refreshContext(`Added ${value} to the orchestrator's context`);
      }
      case "drop":
      case "remove": {
        if (!value) return void s.add({ kind: "error", message: "usage: /context drop <file>" });
        if (!c.include.includes(value)) return void s.add({ kind: "error", message: `${value} is not in the context`, hint: "type /context to see included files" });
        this.setConfig(["context", "include"], c.include.filter((f) => f !== value));
        return this.refreshContext(`Removed ${value} from the context`);
      }
      case "notes": {
        if (!value) return void s.add({ kind: "notice", tone: "memory", text: c.notes?.trim() ? `Notes:
${c.notes}` : "No notes. Set them with /context notes <text>." });
        this.setConfig(["context", "notes"], value === "clear" ? undefined : value);
        return this.refreshContext(value === "clear" ? "Notes cleared" : "Notes updated");
      }
      case "save":
        return this.saveConfig(value || undefined);
      default:
        s.add({ kind: "error", message: `unknown /context option "${sub}"`, hint: "try /context, or: memory on|off · instructions on|off · add <file> · drop <file> · notes <text> · save" });
    }
  }

  async compactCommand(args: string[]) {
    const s = this.store;
    const k = this.cfg.compact;
    const [sub, ...rest] = args;
    switch (sub) {
      case "auto": {
        const v = onOff(rest[0]);
        if (v === undefined) return void s.add({ kind: "error", message: "usage: /compact auto on|off" });
        this.setConfig(["compact", "auto"], v);
        return this.refreshContext(`Auto-compaction ${v ? "on" : "off"}`);
      }
      case "window": {
        const v = parseTokensArg(rest.join(""));
        if (v === undefined || (v !== "auto" && (v < 100_000 || v > 1_000_000))) {
          return void s.add({ kind: "error", message: "usage: /compact window <100k–1m | auto>" });
        }
        this.setConfig(["compact", "window"], v);
        return this.refreshContext(`Compaction window ${v === "auto" ? "set to the model's own" : formatTokens(v)}`);
      }
      case "instructions": {
        const text = rest.join(" ").trim();
        if (!text) return void s.add({ kind: "notice", tone: "memory", text: k.instructions ? `Compaction keeps: ${k.instructions}` : "No extra compaction instructions. Set with /compact instructions <text>." });
        this.setConfig(["compact", "instructions"], text === "clear" ? undefined : text);
        return this.refreshContext(text === "clear" ? "Compaction instructions cleared" : "Compaction instructions updated");
      }
      case "warn": {
        const raw = (rest[0] ?? "").replace("%", "");
        const n = Number(raw) > 1 ? Number(raw) / 100 : Number(raw);
        if (!(n >= 0.1 && n <= 1)) return void s.add({ kind: "error", message: "usage: /compact warn <10–100%>" });
        this.setConfig(["compact", "warn_at"], n);
        return this.refreshContext(`Context warning at ${Math.round(n * 100)}%`);
      }
      case "background": {
        const v = rest[0] ?? "";
        if (v === "on" || v === "off") {
          this.setConfig(["compact", "background"], v === "on");
          if (v === "off") this.stopBackgroundCompaction();
          else this.maybeCompactInBackground();
          return this.refreshContext(v === "on" ? `Background compaction on, from ${Math.round(k.background_at * 100)}% of the window` : "Background compaction off");
        }
        const raw = v.replace("%", "");
        const n = Number(raw) > 1 ? Number(raw) / 100 : Number(raw);
        if (!v || !(n >= 0.1 && n <= 0.95)) {
          return void s.add({
            kind: "error",
            message: "usage: /compact background on|off|<10–95%>",
            hint: `now ${k.background ? `on, from ${Math.round(k.background_at * 100)}%` : "off"}: after a turn, a copy of the conversation is summarized while you keep working`,
          });
        }
        this.setConfig(["compact", "background_at"], n);
        this.maybeCompactInBackground();
        return this.refreshContext(`Background compaction from ${Math.round(n * 100)}% of the window`);
      }
      default:
        return this.compactNow(args.join(" ").trim() || undefined);
    }
  }

  /** Summarize the remembered orchestrator conversation now. */
  private async compactNow(extra?: string) {
    const s = this.store;
    if (s.state.status === "working" || s.state.status === "cancelling") return this.flash("an operation is running — compact after it finishes", 2500);
    if (!this.o.engine.compact) return void s.add({ kind: "error", message: "this engine cannot compact conversations" });
    if (this.bgCompact) return this.flash("already compacting in the background — the next message continues from the summary", 3000);
    if (!this.sdkSessionId) {
      return void s.add({
        kind: "notice",
        tone: "info",
        text: this.cfg.context.memory ? "Nothing to compact yet: there is no remembered conversation." : "Memory is off, so there is no conversation to compact.",
      });
    }
    s.setStatus("working", "compacting conversation");
    this.startTicker();
    this.abort = new AbortController();
    const act = s.add({ kind: "activity", category: "tool", title: `compact	${extra ?? "summarize the conversation"}`, meta: "", state: "running", details: [], expanded: false, startedAt: Date.now() });
    let r: CompactResult | undefined;
    let err: string | undefined;
    try {
      r = await this.o.engine.compact({ cfg: this.cfg, sessionId: this.sdkSessionId, instructions: extra, abort: this.abort, render: this.renderAdapter() });
    } catch (e) {
      err = (e as Error).message;
    }
    this.stopTicker();
    const cancelled = this.abort.signal.aborted;
    this.abort = undefined;
    if (r?.context) s.set({ usage: r.context });
    if (r) s.state.cost.orchestrator += r.costUsd;
    if (r?.ok && r.compaction) {
      this.conv.compactedInPlace();
      this.persist();
      const c = r.compaction;
      s.update(act, { state: "ok", meta: `${formatTokens(c.preTokens)}${c.postTokens !== undefined ? ` → ${formatTokens(c.postTokens)}` : ""} tokens` });
      this.settle();
    } else {
      s.update(act, { state: "failed", meta: cancelled ? "cancelled" : "failed" });
      if (!cancelled) s.add({ kind: "error", message: `compaction failed: ${err ?? r?.error ?? "unknown error"}`, hint: "the conversation is unchanged; you can keep working or /new to start fresh" });
      s.setStatus(cancelled ? "ready" : "fault", cancelled ? "" : "compaction failed");
    }
  }

  /**
   * After a turn, when the conversation passes compact.background_at, compact a fork of it in the
   * background while the user keeps working. The summary is never thrown away: if turns run
   * before it is ready, the next turn resumes the summary and is told about them (Conversation).
   */
  maybeCompactInBackground() {
    const k = this.cfg.compact;
    const u = this.store.state.usage;
    const from = this.conv.sessionId;
    if (!this.o.engine.compact || !from || this.bgCompact || this.conv.summary || this.abort || !this.cfg.context.memory || !k.auto || !k.background) return;
    if (!worthCompacting(u, k)) return;
    const abort = new AbortController();
    const quiet: OrchestratorRender = { assistantText: () => {}, toolCall: () => {}, hooks: {} };
    const afterTurn = this.conv.turn;
    this.adoptSummary(
      this.o.engine.compact({ cfg: this.cfg, sessionId: from, abort, render: quiet, fork: true }).then(
        (r) => (r.ok && r.sessionId ? r : (this.backgroundFailed(r.error, abort), undefined)),
        (e: Error) => (this.backgroundFailed(e.message, abort), undefined),
      ),
      afterTurn,
      undefined,
      abort,
    );
  }

  private backgroundFailed(error: string | undefined, abort: AbortController) {
    if (abort.signal.aborted) return;
    this.store.add({ kind: "notice", tone: "attention", text: `Background compaction failed: ${error ?? "unknown error"}. Nothing changed; Claude Code still compacts when the window fills, or /compact now.` });
  }

  /** A summary on its way (between turns, or left over from a run): use it from the next turn on. */
  private adoptSummary(done: Promise<CompactResult | undefined>, afterTurn: number, tail: string | undefined, abort?: AbortController) {
    const convId = this.conv.state.id;
    const job = { abort: abort ?? new AbortController(), done: Promise.resolve() };
    this.bgCompact = job;
    this.store.set({ compactingInBackground: true });
    job.done = done.then((r) => {
      if (r) this.store.state.cost.orchestrator += r.costUsd;
      if (this.bgCompact === job) {
        this.bgCompact = undefined;
        this.store.set({ compactingInBackground: false });
      }
      if (job.abort.signal.aborted || !r?.sessionId || !r.compaction) return;
      const c = r.compaction;
      if (!this.conv.adopt(convId, { sessionId: r.sessionId, afterTurn, tail, preTokens: c.preTokens, postTokens: c.postTokens })) return;
      this.persist();
      const since = this.conv.turnsSince(this.conv.summary!).length;
      if (!since && !tail && r.context) this.store.set({ usage: r.context });
      this.warned = 0;
      const tokens = `${formatTokens(c.preTokens)}${c.postTokens !== undefined ? ` → ${formatTokens(c.postTokens)}` : ""} tokens`;
      this.store.add({
        kind: "notice",
        tone: "memory",
        text: `Conversation summarized in the background: ${tokens}. ${since || tail ? `The next message continues from the summary, with what happened since (${since ? `${since} turn${since === 1 ? "" : "s"}` : "the end of the run"}).` : "The next message continues from the summary."}`,
      });
    });
  }

  /** Cancel a background compaction (a new turn, /new, exit). */
  private stopBackgroundCompaction() {
    if (!this.bgCompact) return;
    this.bgCompact.abort.abort();
    this.bgCompact = undefined;
    this.store.set({ compactingInBackground: false });
  }

  /** Wait for a background compaction (tests). */
  async backgroundCompaction(): Promise<void> {
    await this.bgCompact?.done;
  }

  /** The conversation state (tests and /context). */
  get conversation(): Conversation {
    return this.conv;
  }

  private warned = 0;

  /** Tell the user once when the conversation crosses the warning threshold. */
  private warnIfContextFull() {
    const u = this.store.state.usage;
    if (!u || !this.cfg.context.memory) return;
    const frac = u.percentage / 100;
    if (frac < this.cfg.compact.warn_at) {
      this.warned = 0;
      return;
    }
    if (this.warned && frac < this.warned + 0.1) return; // don't nag every turn
    this.warned = frac;
    const used = `${formatTokens(u.tokens)} of ${formatTokens(u.max)} tokens (${Math.round(u.percentage)}%)`;
    this.store.add(
      u.autoCompact
        ? { kind: "notice", tone: "memory", text: `Context is ${used}. Auto-compaction will summarize it${u.threshold ? ` at ${formatTokens(u.threshold)}` : ""}.` }
        : { kind: "notice", tone: "attention", text: `Context is ${used} and auto-compaction is off. /compact summarizes it now; /new starts fresh.` },
    );
  }

  private contextReport(): string {
    const c = this.cfg.context;
    const k = this.cfg.compact;
    const u = this.store.state.usage;
    const files = buildContextPrompt(this.cfg, this.o.root).files;
    const lines = [
      "**Context**",
      `- memory: ${c.memory ? (this.sdkSessionId ? `on — continuing (turn ${this.store.state.turn})` : "on — next message starts the conversation") : "off — each message starts fresh"}`,
      u
        ? `- window: ${formatTokens(u.tokens)} of ${formatTokens(u.max)} tokens (${Math.round(u.percentage)}%)${u.autoCompact && u.threshold ? `, auto-compacts at ${formatTokens(u.threshold)}` : ""}`
        : "- window: not measured yet (shown after the first reply)",
    ];
    if (u?.categories.length) {
      const top = [...u.categories].sort((a, b) => b.tokens - a.tokens).slice(0, 4);
      lines.push(`- largest: ${top.map((x) => `${x.name.toLowerCase()} ${formatTokens(x.tokens)}`).join(" · ")}`);
    }
    lines.push(`- project instructions (CLAUDE.md): ${c.project_instructions ? "loaded" : "not loaded"}`);
    lines.push(
      `- included files: ${files.length ? files.map((f) => (f.missing ? `${f.path} (${f.error ?? "missing"})` : `${f.path} (${formatTokens(f.chars)} chars${f.truncated ? ", truncated" : ""})`)).join(", ") : "none"}`,
    );
    lines.push(`- notes: ${c.notes?.trim() ? `"${c.notes.trim().split("\n")[0]!.slice(0, 80)}"` : "none"}`);
    lines.push(
      "",
      "**Compaction**",
      `- auto: ${k.auto ? "on" : "off"} · window: ${k.window === "auto" ? "model default" : formatTokens(k.window)} · warn at ${Math.round(k.warn_at * 100)}%`,
      `- background: ${k.auto && k.background ? `on — from ${Math.round(k.background_at * 100)}%, between turns and while the orchestrator waits on subagents, without blocking${this.bgCompact ? " (summarizing now)" : this.conv.summary ? " (a summary is ready for the next message)" : ""}` : "off"}`,
      `- instructions: ${k.instructions?.trim() ? k.instructions.trim() : "default (task ids, decisions, changed files)"}`,
      "",
      "Change with `/context memory|instructions on|off`, `/context add|drop <file>`, `/context notes <text>`, `/compact auto on|off`, `/compact background on|off|<60%>`, `/compact window <200k|auto>`, `/compact instructions <text>`, `/compact` to summarize now, `/context save` to keep.",
    );
    return lines.join("\n");
  }

  /** Accept a full task id or a unique suffix (the short ids shown in the panel). */
  resolveTask(arg: string): string | undefined {
    if (!arg) return undefined;
    if (this.store.state.tasks.some((t) => t.taskId === arg) || readTaskRecord(this.o.root, arg)) return arg;
    const matches = this.store.state.tasks.filter((t) => t.taskId.endsWith(arg));
    return matches.length === 1 ? matches[0]!.taskId : undefined;
  }

  // ── runs ───────────────────────────────────────────────────────────────────

  /** Custom commands from .yxu/commands and ~/.config/yxu/commands. */
  userCommands: UserCommand[] = [];

  // ── plugins ────────────────────────────────────────────────────────────────

  private panelTimers: ReturnType<typeof setInterval>[] = [];
  private lastOutcome?: { ok: boolean; result: string };

  /** Let plugins talk to this interface, fill their panel sections, and say what waits for approval. */
  private startPlugins() {
    setPluginHost({
      note: (m) => this.note(m),
      run: async (goal, opts = {}) => {
        let wf: Workflow & { name: string } | undefined;
        if (opts.workflow) wf = getWorkflow(this.cfg, opts.workflow);
        this.startGoal(goal, { workflow: wf, inputs: opts.inputs });
        await this.running;
        return this.lastOutcome ?? { ok: false, result: "the run did not start (another one is running)" };
      },
    });
    const reg = this.cfg.plugins;
    if (!reg) return;
    for (const e of reg.entries.filter((x) => x.status === "error")) this.fail(`plugin ${e.id} could not be loaded`, e.error);
    const waiting = reg.entries.filter((e) => e.status === "pending" || e.status === "changed");
    if (waiting.length) {
      this.store.add({
        kind: "notice",
        tone: "attention",
        text: `**Plugins wait for your approval.** Plugins are code that runs inside yxu with your permissions:\n${waiting.map((e) => `- ${e.id} — ${display(e.path, this.o.root)}${e.status === "changed" ? " (changed since you approved it)" : ""}${e.pack ? ` (pack ${e.pack})` : ""}`).join("\n")}\n\nRead them, then /plugins approve to load them.`,
      });
    }
    for (const { panel } of reg.panels) {
      if (panel.refresh && panel.refresh > 0) this.panelTimers.push(setInterval(() => void this.refreshPanels(), Math.max(1, panel.refresh) * 1000));
    }
    for (const t of this.panelTimers) (t as { unref?: () => void }).unref?.();
    void this.refreshPanels();
  }

  /** Ask every plugin panel for fresh lines (errors show in the section itself). */
  async refreshPanels() {
    const reg = this.cfg.plugins;
    if (!reg?.panels.length) return;
    const panels = await Promise.all(
      reg.panels.map(async ({ plugin, panel }) => {
        let lines: string[];
        try {
          const out = await panel.render(pluginContext(plugin, this.o.root, this.cfg as unknown as Record<string, unknown>));
          lines = Array.isArray(out) ? out.map(String) : [String(out)];
        } catch (e) {
          lines = [`! ${(e as Error).message}`];
        }
        return { id: `${plugin}:${panel.title}`, title: panel.title, lines };
      }),
    );
    this.store.set({ pluginPanels: panels });
  }

  /** `/<plugin>:<command>`: run a plugin's command; failures show as faults. */
  async runPluginCommand(plugin: string, command: PluginCommand, args: string[]) {
    try {
      await command.run(pluginContext(plugin, this.o.root, this.cfg as unknown as Record<string, unknown>), args);
    } catch (e) {
      this.fail(`/${plugin}:${command.name} failed: ${(e as Error).message}`);
    }
    void this.refreshPanels();
  }

  /** `/plugins`: every plugin found, its state, and what it adds. */
  listPlugins() {
    const entries = this.cfg.plugins?.entries ?? [];
    if (!entries.length) return this.note("No plugins. Put one in .yxu/plugins/ (team) or ~/.config/yxu/plugins/ (you), or install a pack that has one. See docs/PLUGINS.md.", "info");
    const lines = entries.map((e) => {
      const p = e.plugin;
      const adds = p
        ? [p.commands?.length && `commands ${p.commands.map((c) => `/${p.name}:${c.name}`).join(" ")}`, p.panel?.length && `panel ${p.panel.map((x) => x.title).join(", ")}`, p.hooks && `hooks ${Object.keys(p.hooks).join(", ")}`, p.agents?.length && `agents ${p.agents.map((a) => a.cli).join(", ")}`, p.orchestrators?.length && `orchestrators ${p.orchestrators.map((o) => o.name).join(", ")}`].filter(Boolean).join(" · ")
        : "";
      const state = { loaded: "loaded", pending: "**waits for approval** (/plugins approve)", changed: "**changed since approved** (/plugins approve)", error: `**error**: ${e.error}` }[e.status];
      return `- **${p?.name ?? e.id}** · ${e.scope}${e.pack ? ` · pack ${e.pack}` : ""} · ${state}\n  ${display(e.path, this.o.root)}${adds ? `\n  ${adds}` : ""}`;
    });
    this.note(["**Plugins**", ...lines].join("\n"));
  }

  /** `/plugins approve [name]`: approve this repo's waiting plugins (at their current code) and load them. */
  approvePlugins(name?: string) {
    const waiting = (this.cfg.plugins?.entries ?? []).filter((e) => (e.status === "pending" || e.status === "changed") && (!name || e.id === name));
    if (!waiting.length) return this.note(name ? `No plugin ${name} waits for approval.` : "No plugins wait for approval.", "info");
    for (const e of waiting) setApproval(e.path, true);
    this.reloadPlugins();
    this.note(`Approved ${waiting.map((e) => e.id).join(", ")}. They load now, and again only while their code stays the same.`, "ok");
  }

  revokePlugin(name?: string) {
    const e = (this.cfg.plugins?.entries ?? []).find((x) => x.scope === "project" && (x.id === name || x.plugin?.name === name));
    if (!e) return this.fail(`no plugin ${name ?? "(name?)"} from this repo`, "usage: /plugins revoke <name>");
    setApproval(e.path, false);
    this.reloadPlugins();
    this.note(`${e.id} is no longer approved; it won't load.`, "attention");
  }

  /** Load plugins again (after an approval): new commands, panels and agents appear. */
  private reloadPlugins() {
    const reg = loadPlugins(this.o.root);
    Object.defineProperty(this.cfg, "plugins", { value: reg, enumerable: false, writable: true });
    for (const t of this.panelTimers) clearInterval(t);
    this.panelTimers = [];
    this.startPlugins();
  }

  /** `/packs`: installed packs, their state against yxu.lock, and what each adds. */
  listPacks() {
    let rows: PackStatus[];
    try {
      rows = packStatus(this.o.root);
    } catch (e) {
      return this.fail((e as Error).message);
    }
    if (!rows.length) {
      return this.note("No packs installed. In a shell: `yxu add python` (or node, rust, go), `yxu add github:owner/repo`, or `yxu add ./folder`.", "info");
    }
    const lines = rows.map((r) => {
      const state = { ok: "", modified: " — **differs from yxu.lock**", missing: " — **missing**: run `yxu packs install`", unlocked: " — not in yxu.lock" }[r.state];
      const head = `- **${r.name}** ${r.version ?? ""} · ${r.scope} · ${r.source ?? "?"}${r.commit ? ` @ ${r.commit.slice(0, 10)}` : ""}${state}`;
      if (!r.pack) return head;
      const c = packContents(r.pack);
      const parts = [c.workflows.length && `workflows ${c.workflows.join(", ")}`, c.commands.length && `commands ${c.commands.join(" ")}`, c.prompts.length && `prompts ${c.prompts.join(", ")}`, c.themes.length && `themes ${c.themes.join(", ")}`].filter(Boolean);
      return parts.length ? `${head}
  ${parts.join(" · ")}` : head;
    });
    this.note(["**Packs**", ...lines, "", "Manage them in a shell: `yxu packs update`, `yxu packs remove <name>`."].join("\n"));
  }

  reloadUserCommands(report = false) {
    let errors: string[] = [];
    try {
      ({ commands: this.userCommands, errors } = loadUserCommands(this.o.root, this.cfg, COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])])));
    } catch (e) {
      errors = [(e as Error).message];
    }
    this.store.set({ customHelp: this.userCommands.map((c) => [`/${c.name}${c.args.length ? ` ${commandUsage(c)}` : ""}`, c.description]) });
    if (errors.length) this.fail(`${errors.length} custom command${errors.length === 1 ? "" : "s"} could not be loaded`, errors.join("\n"));
    if (!report) return;
    if (!this.userCommands.length) {
      return this.note("No custom commands yet. Add Markdown files to .yxu/commands/ (team) or ~/.config/yxu/commands/ (you), e.g. .yxu/commands/add-tests.md", "info");
    }
    this.note(
      ["**Your commands**", ...this.userCommands.map((c) => `- \`/${c.name}${c.args.length ? ` ${commandUsage(c)}` : ""}\` — ${c.description} · ${c.kind} · ${display(c.file, this.o.root)}`)].join("\n"),
    );
  }

  /** Run a custom command: send its prompt, run its workflow, or run its shell command. */
  async runUserCommand(c: UserCommand, args: string[]) {
    let x;
    try {
      x = expandCommand(c, args, this.cfg);
    } catch (e) {
      return this.fail((e as Error).message);
    }
    if (x.kind === "shell" && c.scope === "project" && this.cfg.trusted === false) {
      return this.fail(`/${c.name} runs \`${x.command}\` from this repository's .yxu/commands`, "yxu runs commands from a repo's own files only after you trust it: /trust");
    }
    if (x.kind === "prompt") return this.startGoal(x.goal, { workflow: x.workflow });
    if (x.kind === "workflow") return this.startGoal(x.goal || `/${c.name} ${args.join(" ")}`.trim(), { workflow: x.workflow, inputs: x.inputs });
    const s = this.store;
    const a = s.add({ kind: "activity", category: "shell", title: `/${c.name}\t${x.command.split("\n")[0]}`, meta: "", state: "running", details: [], expanded: false, taskId: `cmd:${c.name}:${Date.now()}`, startedAt: Date.now() });
    const v = await runVerify(this.o.root, x.command, this.cfg.settings.verify_timeout);
    s.update(a, {
      state: v.ok ? "ok" : "failed",
      meta: `${v.ok ? "ok" : v.timedOut ? "timed out" : `exit ${v.exitCode}`} · ${(v.durationMs / 1000).toFixed(1)}s`,
      details: v.output ? v.output.split("\n") : ["(no output)"],
      expanded: true,
    });
  }

  /** `/run <workflow> name=value … [goal]`: run a workflow once with inputs. */
  runWorkflow(args: string[]) {
    const [name, ...rest] = args;
    if (!name) return this.fail("which workflow?", "usage: /run <workflow> [name=value]… [goal]");
    let wf: Workflow & { name: string };
    try {
      wf = getWorkflow(this.cfg, name);
    } catch (e) {
      return this.fail((e as Error).message, "type /workflow to list workflows");
    }
    const inputs: Record<string, string> = {};
    let i = 0;
    for (; i < rest.length && /^[\w-]+=/.test(rest[i]!); i++) {
      const eq = rest[i]!.indexOf("=");
      inputs[rest[i]!.slice(0, eq)] = rest[i]!.slice(eq + 1);
    }
    const goal = rest.slice(i).join(" ").trim();
    if (wf.mode !== "pipeline") {
      if (Object.keys(inputs).length) return this.fail(`"${wf.name}" is an ${wf.mode} workflow; inputs are for pipelines`);
      if (!goal) return this.fail(`"${wf.name}" needs a goal`, `/run ${wf.name} <what to do>`);
    }
    return this.startGoal(goal || `run ${wf.name}`, { workflow: wf, inputs });
  }

  /** Start a run now (used by /run and custom commands). */
  startGoal(goal: string, run?: { workflow?: Workflow & { name: string }; inputs?: Record<string, string> }) {
    const st = this.store.state;
    if (st.status === "working" || st.status === "cancelling") return this.flash("an operation is running — esc cancels it", 2500);
    if (st.status === "deciding") this.clearDecision(true);
    this.running = this.startRun(goal, run);
  }

  private async startRun(goal: string, run?: { workflow?: Workflow & { name: string }; inputs?: Record<string, string> }) {
    const s = this.store;
    s.set({ turn: s.state.turn + 1 });
    const issue = this.runIssue;
    this.runIssue = undefined;
    const before = new Set(this.session.tasks.keys());
    const time = new Date();
    s.add({
      kind: "divider",
      label: `${this.sdkSessionId ? "continuing" : "turn"} ${s.state.turn} · ${time.toTimeString().slice(0, 5)}`,
    });
    s.add({ kind: "user", text: goal, time });
    const wf = run?.workflow ?? this.workflow;
    const remember = this.cfg.context.memory && wf.mode === "auto";
    const next = remember ? this.conv.next() : { usesSummary: false as const };
    s.setStatus("working", wf.mode === "pipeline" ? `pipeline ${wf.name}` : "orchestrator planning");
    this.startTicker();
    this.abort = new AbortController();
    this.streaming = undefined;
    this.openRead = undefined;

    let outcome: RunOutcome | undefined;
    let thrown: unknown;
    this.lastOutcome = undefined;
    try {
      outcome = await this.o.engine.run({
        goal,
        workflow: run?.workflow ?? this.workflow,
        render: this.renderAdapter(),
        abort: this.abort,
        session: this.session,
        resume: next.resume,
        preamble: next.preamble,
        history: this.conv.state.log,
        cfg: this.cfg,
        inputs: run?.inputs,
        gate: (message, stepId) => this.askGate(message, stepId),
      });
    } catch (e) {
      thrown = e;
    }
    this.lastOutcome = outcome ? { ok: outcome.ok, result: outcome.finalText } : { ok: false, result: thrown ? (thrown as Error).message : "the run failed" };
    this.stopTicker();
    this.finishStreaming();
    this.markStragglers();
    s.set({ activeSlots: 0 });
    this.syncTasks();
    try {
      const made = [...this.session.tasks.keys()].filter((id) => !before.has(id));
      // Every run is part of the session (pipelines too: their tasks), not only conversation turns.
      this.saved.tasks.push(...made.filter((id) => !this.saved.tasks.includes(id)));
      if (!this.saved.title) this.saved.title = titleFrom(issue ? `${issue.title} (${issue.id})` : goal);
      this.saved.workflow = wf.name;
      if (outcome) this.saved.costUsd += outcome.costUsd;
      this.persist();
      if (issue) tagIssue(this.o.root, made, issue);
      if (outcome?.ok) tagRun(this.o.root, made, { goal: issue ? `${issue.title} (${issue.id})` : goal, report: outcome.finalText });
    } catch {
      // best effort: only pull request descriptions depend on it
    }

    const cancelled = this.abort.signal.aborted || outcome?.cancelled;
    this.abort = undefined;

    if (outcome) {
      s.state.cost.orchestrator += outcome.costUsd;
      if (remember && outcome.memoryRebuilt) {
        s.add({ kind: "notice", tone: "attention", text: "This session's conversation history was gone (neither yxu's copy nor Claude Code's had it), so the orchestrator continued from yxu's record of its turns." });
      }
      if (remember) {
        this.conv.finish({ goal, finalText: outcome.finalText, sessionId: outcome.sdkSessionId, usedSummary: next.usesSummary });
        this.persist();
        if (outcome.sdkSessionId) s.set({ remembering: true });
        // A summary the run started but didn't get to use serves the next turn.
        if (outcome.backgroundSummary && !this.bgCompact && !this.conv.summary) this.adoptSummary(outcome.backgroundSummary.done, this.conv.turn, outcome.backgroundSummary.tail || undefined);
      }
      if (outcome.context) s.set({ usage: outcome.context });
      for (const f of outcome.contextFiles ?? []) {
        if (f.missing) s.add({ kind: "notice", tone: "attention", text: `Context file ${f.path} was not included: ${f.error ?? "not found"}. Fix it with /context drop ${f.path}.` });
      }
    }

    if (cancelled) {
      s.add({ kind: "notice", tone: "attention", text: "Cancelled. Your branch is untouched; finished results stay reviewable below." });
    } else if (thrown || !outcome?.ok) {
      const message = thrown ? (thrown as Error).message : (outcome?.finalText ?? "the run failed");
      s.add({ kind: "error", message, hint: recoveryHint(message) });
    } else if (outcome.finalText.trim() && !this.lastAssistantEquals(outcome.finalText)) {
      s.add({ kind: "assistant", text: outcome.finalText, streaming: false });
    }

    this.warnIfContextFull();
    if (!cancelled) this.maybeCompactInBackground();
    if (this.offerDecision()) return;
    if (!cancelled && (thrown || !outcome?.ok)) s.setStatus("fault", "see the fault below");
    else this.settle();
  }

  private lastAssistantEquals(text: string): boolean {
    const last = [...this.store.state.entries].reverse().find((e) => e.kind === "assistant");
    return !!last && last.kind === "assistant" && last.text.trim() === text.trim();
  }

  /** Calm return to readiness after a completion. */
  private settle() {
    this.store.setStatus("complete");
    const delay = this.theme.reducedMotion ? 0 : 1400;
    setTimeout(() => {
      if (this.store.state.status === "complete") this.store.setStatus("ready");
    }, delay);
  }

  private approvals: { req: PermissionRequest; resolve: (a: Answer) => void }[] = [];

  /** An agent wants to use a tool its permissions don't cover: ask (one question at a time). */
  askApproval(req: PermissionRequest): Promise<Answer> {
    return new Promise((resolve) => {
      this.approvals.push({ req, resolve });
      this.showApproval(); // the first question stays up; the count of waiting ones grows
    });
  }

  private showApproval() {
    const next = this.approvals[0];
    this.store.set({ approval: next ? { message: describe(next.req), agent: next.req.agent, waiting: this.approvals.length - 1 } : undefined, scroll: 0 });
  }

  answerApproval(answer: Answer) {
    const cur = this.approvals.shift();
    if (!cur) return;
    this.store.add({ kind: "notice", tone: answer === "deny" ? "attention" : "ok", text: `${answer === "deny" ? "Denied" : answer === "always" ? "Allowed for this session" : "Allowed once"}: ${describe(cur.req)}` });
    cur.resolve(answer);
    this.showApproval();
  }

  private gateAnswer?: (ok: boolean) => void;

  /** Show a gate and wait for the user (y continues, n stops the workflow). */
  askGate(message: string, stepId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.gateAnswer = resolve;
      this.store.set({ gate: { message, stepId }, scroll: 0 });
      this.store.setStatus("working", `waiting for you at ${stepId}`);
    });
  }

  answerGate(ok: boolean) {
    const gt = this.store.state.gate;
    const done = this.gateAnswer;
    if (!gt || !done) return;
    this.gateAnswer = undefined;
    this.store.set({ gate: undefined });
    this.store.add({ kind: "notice", tone: ok ? "ok" : "attention", text: `${ok ? "Continued" : "Stopped"} at ${gt.stepId}: ${gt.message}` });
    this.store.setStatus("working", ok ? `continuing after ${gt.stepId}` : "stopping");
    done(ok);
  }

  cancel() {
    this.answerGate(false);
    while (this.approvals.length) this.answerApproval("deny");
    if (!this.abort || this.abort.signal.aborted) return;
    this.store.setStatus("cancelling", "stopping agents");
    this.abort.abort();
    killAllSubagents();
  }

  private startTicker() {
    clearInterval(this.ticker);
    // Reduced motion: no pulse, only the elapsed counter (once a second).
    const every = this.theme.reducedMotion ? 1000 : 125;
    this.ticker = setInterval(() => {
      this.tick++;
      this.requestRender();
    }, every);
  }

  private stopTicker() {
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private finishStreaming() {
    if (this.streaming) {
      this.store.update(this.streaming, { streaming: false });
      this.streaming = undefined;
    }
  }

  /** Anything still "running" when the run ended was interrupted. */
  private markStragglers() {
    for (const a of this.store.activities()) {
      if (a.state === "running") this.store.update(a, { state: "failed", meta: "interrupted" });
    }
  }

  private findActivity(taskId: string): Activity | undefined {
    return this.store.activities().find((a) => a.taskId === taskId);
  }

  /** Translate orchestrator/agent events into conversation entries. Observable facts only. */
  renderAdapter(): OrchestratorRender {
    const s = this.store;
    const closeRead = () => (this.openRead = undefined);
    const slots = (delta: number) => {
      const n = Math.max(0, s.state.activeSlots + delta);
      s.set({ activeSlots: n, statusNote: n ? `${n} agent${n === 1 ? "" : "s"} at work` : "orchestrator reviewing" });
    };

    return {
      compacted: (info) => {
        closeRead();
        const after = info.postTokens !== undefined ? ` → ${formatTokens(info.postTokens)}` : "";
        s.add({
          kind: "notice",
          tone: "memory",
          text:
            info.trigger === "background"
              ? `Conversation summarized in the background while subagents worked: ${formatTokens(info.preTokens)}${after} tokens. The run continues from the summary, without a pause.`
              : `Conversation compacted (${info.trigger}): ${formatTokens(info.preTokens)}${after} tokens. Memory continues from the summary.`,
        });
      },
      textStart: () => {
        closeRead();
        this.finishStreaming();
        this.streaming = s.add({ kind: "assistant", text: "", streaming: true });
      },
      textDelta: (chunk) => {
        if (!this.streaming) this.streaming = s.add({ kind: "assistant", text: "", streaming: true });
        this.streaming.text += chunk;
        this.streaming.version++;
        s.changed();
      },
      assistantText: (text) => {
        closeRead();
        if (this.streaming) {
          s.update(this.streaming, { text, streaming: false });
          this.streaming = undefined;
        } else {
          s.add({ kind: "assistant", text, streaming: false });
        }
      },
      toolCall: (name, input) => {
        const short = name.replace(/^mcp__yxu__/, "");
        if (HOOKED_TOOLS.has(short)) {
          if (short === "delegate_parallel" && Array.isArray(input.tasks)) {
            closeRead();
            s.set({ statusNote: `${input.tasks.length} tasks in parallel` });
          }
          return;
        }
        const target = String(input.file_path ?? input.pattern ?? input.path ?? input.task_id ?? "");
        if (READ_TOOLS.has(short)) {
          const line = `${short.toLowerCase()} ${target}`.trim();
          if (this.openRead && s.state.entries.at(-1) === this.openRead) {
            const details = [...this.openRead.details, line];
            const targets = [...new Set(details.map((d) => d.split(" ").slice(1).join(" ").split("/").at(-1)!).filter(Boolean))];
            s.update(this.openRead, { details, meta: `${details.length} lookups`, title: `read\t${targets.join(", ")}` });
          } else {
            this.openRead = s.add({ kind: "activity", category: "read", title: `read\t${target}`, meta: "1 lookup", state: "ok", details: [line], expanded: false, startedAt: Date.now() });
          }
          return;
        }
        closeRead();
        s.add({ kind: "activity", category: "tool", title: `${short}\t${target}`, meta: "", state: "ok", details: [], expanded: false, startedAt: Date.now() });
      },
      step: ({ id, type, index, total, note }) => {
        closeRead();
        if (type === "fix") s.add({ kind: "notice", tone: "attention", text: `${note ?? "fixing"} (round ${index}/${total})` });
        else {
          s.add({ kind: "step", index, total, name: note ? `${id} · ${note}` : id, type });
          s.set({ statusNote: `step ${index}/${total} · ${id}` });
        }
      },
      ask: (req) => this.askApproval(req),
      hooks: {
        onDelegateStart: ({ taskId, agent, model, task, buildOn }) => {
          closeRead();
          const first = task.trim().split("\n")[0] ?? "";
          s.add({
            kind: "activity",
            category: "delegate",
            title: `${agent}\t${first}`,
            meta: "",
            state: "running",
            details: [`task ${taskId}${buildOn ? ` (builds on ${buildOn})` : ""}`, `agent ${agent}${model ? ` · ${model}` : ""}`, "", ...task.trim().split("\n")],
            expanded: false,
            taskId,
            startedAt: Date.now(),
          });
          s.upsertTask({ taskId, agent, state: "running", title: first, files: 0, pending: false });
          slots(1);
        },
        onAgentEvent: (taskId, e) => {
          const a = this.findActivity(taskId);
          if (!a || a.state !== "running") return;
          const line =
            e.kind === "tool"
              ? `${e.status === "failed" ? "✗" : e.status === "completed" ? "✓" : "·"} ${e.name}${e.target ? ` ${e.target}` : ""}`
              : e.kind === "permission"
                ? `△ ${e.tool} — ${e.decision}`
                : e.kind === "error"
                  ? `! ${e.message}`
                  : undefined;
          if (!line) return;
          // Live progress: the newest tool shows as the row's meta, the trail in its details.
          s.update(a, { details: [...a.details, line], meta: e.kind === "tool" && e.status === "started" ? `${e.name}${e.target ? ` ${e.target.split("/").at(-1)}` : ""}` : a.meta });
        },
        onDelegateEnd: (r) => {
          this.finishActivity(r);
          s.state.cost.subagents += r.costUsd ?? 0;
          s.upsertTask({ taskId: r.taskId, agent: r.agent, state: r.ok ? "ok" : "failed", title: this.findActivity(r.taskId)?.title.split("\t")[1] ?? "", files: r.filesChanged.length, pending: !!r.branch });
          slots(-1);
          void this.refreshPanels();
        },
        onCombineStart: (ids) => {
          closeRead();
          s.add({ kind: "activity", category: "combine", title: `combine\t${ids.length} results`, meta: "", state: "running", details: ids.map((i) => `merge ${i}`), expanded: false, taskId: `combine:${ids.join(",")}`, startedAt: Date.now() });
        },
        onConflict: (files, id) => {
          const a = this.store.activities().findLast((x) => x.category === "combine" && x.state === "running");
          if (a) s.update(a, { details: [...a.details, `conflict merging ${id}: ${files.join(", ")} — resolver agent working`], meta: "resolving conflict" });
        },
        onCombineEnd: (r) => {
          const a = this.store.activities().findLast((x) => x.category === "combine" && x.state === "running");
          if (a) {
            s.update(a, {
              state: r.ok ? "ok" : "failed",
              meta: r.ok ? `${r.filesChanged.length} files` : "failed",
              details: [...a.details, "", r.ok ? r.summary : `error: ${r.error}`],
              taskId: r.taskId,
            });
          }
          s.state.cost.subagents += r.costUsd ?? 0;
          if (r.ok) s.upsertTask({ taskId: r.taskId, agent: "combine", state: "ok", title: r.summary, files: r.filesChanged.length, pending: true });
        },
        onVerifyStart: (command, taskId) => {
          closeRead();
          s.add({ kind: "activity", category: "verify", title: `verify\t${command}`, meta: "", state: "running", details: [], expanded: false, taskId: `verify:${taskId ?? ""}:${Date.now()}`, startedAt: Date.now() });
          s.set({ statusNote: "verifying" });
        },
        onVerifyEnd: (v) => {
          const a = this.store.activities().findLast((x) => x.category === "verify" && x.state === "running");
          if (!a) return;
          const outcome = v.ok ? "passed" : v.timedOut ? "timed out" : `failed · exit ${v.exitCode}`;
          s.update(a, {
            state: v.ok ? "ok" : "failed",
            meta: `${outcome} · ${(v.durationMs / 1000).toFixed(1)}s`,
            details: v.output ? v.output.split("\n") : ["(no output)"],
            // Failures open by default: the output is the explanation.
            expanded: !v.ok,
          });
        },
        onDiscard: (id) => {
          const t = s.state.tasks.find((x) => x.taskId === id);
          if (t) s.upsertTask({ ...t, state: "discarded", pending: false });
        },
        onShellStart: ({ id, command }) => {
          closeRead();
          s.add({ kind: "activity", category: "shell", title: `shell\t${command.split("\n")[0]}`, meta: "", state: "running", details: [], expanded: false, taskId: `shell:${id}:${Date.now()}`, startedAt: Date.now() });
          s.set({ statusNote: `running ${id}` });
        },
        onShellEnd: ({ result: v, task }) => {
          const a = this.store.activities().findLast((x) => x.category === "shell" && x.state === "running");
          if (!a) return;
          const outcome = v.ok ? "ok" : v.timedOut ? "timed out" : `failed · exit ${v.exitCode}`;
          const changed = task ? ` · ${task.filesChanged.length} file${task.filesChanged.length === 1 ? "" : "s"} changed` : "";
          s.update(a, {
            state: v.ok ? "ok" : "failed",
            meta: `${outcome}${changed} · ${(v.durationMs / 1000).toFixed(1)}s`,
            details: [...(v.output ? v.output.split("\n") : ["(no output)"]), ...(task ? ["", `task ${task.taskId}: ${task.filesChanged.join(", ")}`] : [])],
            expanded: !v.ok,
          });
          if (task) s.upsertTask({ taskId: task.taskId, agent: "shell", state: "ok", title: a.title.split("\t")[1] ?? "shell", files: task.filesChanged.length, pending: true });
        },
      },
    };
  }

  private finishActivity(r: TaskResult) {
    const a = this.findActivity(r.taskId);
    if (!a) return;
    const secs = `${(r.durationMs / 1000).toFixed(0)}s`;
    const files = r.filesChanged.length ? `${r.filesChanged.length} file${r.filesChanged.length === 1 ? "" : "s"}` : "no changes";
    const result = ["", "— result —", ...(r.error ? [`error: ${r.error}`] : []), ...(r.summary ? r.summary.split("\n") : []), ...(r.filesChanged.length ? ["", `files: ${r.filesChanged.join(", ")}`] : [])];
    this.store.update(a, {
      state: r.ok ? "ok" : "failed",
      meta: r.ok ? `${secs} · ${files}` : `${secs} · ${firstLine(r.error ?? "failed")}`,
      details: [...a.details, ...result],
      expanded: !r.ok ? true : a.expanded,
    });
  }

  /** Refresh the panel's task list from the session (pending = what the user can apply). */
  private syncTasks() {
    const tips = new Set(this.session.tips().map((t) => t.taskId));
    for (const t of this.session.tasks.values()) {
      const existing = this.store.state.tasks.find((x) => x.taskId === t.taskId);
      const view: TaskView = {
        taskId: t.taskId,
        agent: t.agent,
        state: t.discarded ? "discarded" : t.ok ? "ok" : "failed",
        title: existing?.title || firstLine(t.prompt),
        files: t.filesChanged.length,
        pending: tips.has(t.taskId),
      };
      this.store.upsertTask(view);
    }
  }

  // ── decisions ──────────────────────────────────────────────────────────────

  /** After a run: if results are waiting, ask the user what to do with them. */
  private offerDecision(): boolean {
    const tips = this.session.tips().filter((t) => this.backend.exists(t.taskId));
    if (!tips.length) return false;
    const head = tips.at(-1)!;
    const diff = this.backend.diff(head.taskId);
    this.store.set({
      decision: { taskId: head.taskId, agent: head.agent, stat: diffStat(diff), includes: this.session.ancestorCount(head.taskId), others: tips.slice(0, -1).map((t) => t.taskId) },
    });
    this.store.setStatus("deciding", "a result is ready for review");
    return true;
  }

  private clearDecision(deferred = false) {
    const d = this.store.state.decision;
    if (!d) return;
    this.store.set({ decision: undefined });
    if (deferred) this.store.add({ kind: "notice", tone: "info", text: `Kept for later: /apply ${d.taskId}` });
  }

  async decide(choice: "apply" | "view" | "later" | "discard" | "pr") {
    const d = this.store.state.decision;
    if (!d) return;
    if (choice === "view") return this.showDiff(d.taskId);
    if (choice === "pr") {
      this.store.set({ decision: undefined });
      this.pullRequest(d.taskId);
      if (!this.offerDecision() && this.store.state.status !== "fault") this.settle();
      return;
    }
    if (choice === "later") {
      this.clearDecision(true);
      this.store.setStatus("ready");
      return;
    }
    this.store.set({ decision: undefined });
    if (choice === "apply") await this.applyTask(d.taskId);
    else this.discardTask(d.taskId);
    if (!this.offerDecision() && this.store.state.status !== "fault") this.settle();
  }

  // ── watching and stepping in ──────────────────────────────────────────────

  private watchTimer?: ReturnType<typeof setInterval>;
  private unwatch?: () => void;
  private watchFollow = false;

  /** `/watch [task|off]`: show a running agent live in the side panel; no task: follow whichever runs. */
  watchCommand(arg = "") {
    if (arg === "off") {
      this.stopWatching();
      return this.note("Stopped watching.", "info");
    }
    const target = arg ? this.liveTarget(arg) : liveTasks().at(-1);
    if (typeof target === "string") return this.fail(target);
    this.watchFollow = !arg;
    this.unwatch ??= onLiveChange((id) => {
      if (this.store.state.watch?.taskId === id || (this.watchFollow && liveTask(id))) this.refreshWatch(id);
    });
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => this.refreshWatch(), 1500);
      this.watchTimer.unref?.();
    }
    if (!target) {
      this.store.set({ watch: undefined });
      return this.note("No agent is running. Watching is on: the next one to start shows in the side panel. `/watch off` stops.", "info");
    }
    this.refreshWatch(target.taskId);
  }

  private stopWatching() {
    clearInterval(this.watchTimer);
    this.watchTimer = undefined;
    this.unwatch?.();
    this.unwatch = undefined;
    this.watchFollow = false;
    this.store.set({ watch: undefined });
  }

  /** Rebuild the watch view: the agent's live state, its activity, and its changes so far. */
  private refreshWatch(id?: string) {
    const prev = this.store.state.watch;
    let taskId = id ?? prev?.taskId;
    // Following: move on to a running agent when the watched one has finished.
    if (this.watchFollow && (!taskId || !liveTask(taskId))) taskId = liveTasks().at(-1)?.taskId ?? taskId;
    if (!taskId) return;
    const ctl = liveTask(taskId);
    if (!ctl) {
      if (prev?.taskId === taskId && prev.state !== "finished") this.store.set({ watch: { ...prev, state: "finished" } });
      return;
    }
    // Paths inside the agent's worktree, shown relative to the repository.
    const rel = (t: string) => t.split(`${ctl.worktree}/`).join("");
    const activity = ctl.events.flatMap((e) =>
      e.kind === "tool"
        ? [`${e.status === "failed" ? "✗" : e.status === "completed" ? "✓" : "·"} ${e.name}${e.target ? ` ${rel(e.target)}` : ""}`]
        : e.kind === "text" && e.text.trim()
          ? [`“${e.text.trim().split("\n")[0]}”`]
          : e.kind === "error"
            ? [`! ${e.message}`]
            : [],
    );
    const changes = worktreeChanges(ctl.worktree);
    this.store.set({
      watch: { taskId, agent: ctl.agent, model: ctl.model, state: ctl.state, startedAt: ctl.startedAt, activity, log: [...ctl.log], files: changes.files, diffTail: changes.tail, follow: this.watchFollow },
    });
  }

  /** The running task a command means: named (any part of its id), watched, or the only one. */
  private liveTarget(arg?: string): LiveControl | string {
    const all = liveTasks();
    if (!all.length) return "no agent is running right now";
    if (arg) return all.find((t) => t.taskId === arg || t.taskId.endsWith(arg)) ?? `no running task matching "${arg}" (running: ${all.map((t) => shortTask(t.taskId)).join(", ")})`;
    const watched = this.store.state.watch && liveTask(this.store.state.watch.taskId);
    if (watched) return watched;
    if (all.length === 1) return all[0]!;
    return `${all.length} agents are running (${all.map((t) => `${shortTask(t.taskId)} ${t.agent}`).join(", ")}); name one, or /watch it first`;
  }

  /** `/tell [task] <message>`: the agent stops and continues with the message. */
  tell(args: string[]) {
    const first = args[0] ?? "";
    const named = liveTasks().some((t) => t.taskId === first || (first.length >= 4 && t.taskId.endsWith(first)));
    const target = this.liveTarget(named ? first : undefined);
    const message = (named ? args.slice(1) : args).join(" ").trim();
    if (!message) return this.fail("usage: /tell [task] <message for the agent>");
    if (typeof target === "string") return this.fail(target);
    const err = target.steer(message);
    if (err) return this.fail(`can't message ${target.agent}: ${err}`);
    this.note(`Told ${target.agent} (${shortTask(target.taskId)}): ${message}${/[.!?]$/.test(message) ? "" : "."} It continues with it; its work so far is kept.`, "info");
    if (!this.store.state.watch) this.watchCommand(target.taskId);
  }

  /** `/pause`, `/resume`, `/takeover`, `/done` for a running task. */
  liveAction(kind: "pause" | "resume" | "takeover" | "done", arg?: string) {
    const target = this.liveTarget(arg);
    if (typeof target === "string") return this.fail(target);
    const err = kind === "pause" ? target.pause() : kind === "resume" ? target.resume() : kind === "takeover" ? target.takeOver() : target.done();
    if (err) return this.fail(`can't ${kind === "takeover" ? "take over" : kind} ${target.agent}: ${err}`);
    const id = shortTask(target.taskId);
    if (kind === "pause") this.note(`Paused ${target.agent} (${id}); its timeout is paused too. /continue lets it go on.`, "info");
    if (kind === "resume") this.note(`${target.agent} (${id}) continues.`, "info");
    if (kind === "done") this.note(`Handed ${id} back: your edits and the agent's are collected as the task's result.`, "ok");
    if (kind === "takeover") {
      const opened = openEditor(target.worktree);
      this.note(
        `${target.agent} stopped; ${id} is yours. Edit in \`${target.worktree}\`${opened ? ` (opened in ${opened})` : " (open it in your editor)"}, then \`/done\` hands it back: the orchestrator continues with your changes and the agent's.`,
        "attention",
      );
    }
    if (!this.store.state.watch) this.watchCommand(target.taskId);
    else this.refreshWatch(target.taskId);
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  /** Save this session (no-op until its first turn). */
  private persist() {
    if (this.o.demo) return;
    this.saved.conversation = this.conv.state;
    this.saved.branch = tryGit(this.o.root, "branch", "--show-current").out || undefined;
    try {
      saveSession(this.saved);
    } catch (e) {
      this.flash(`couldn't save the session: ${(e as Error).message}`, 3000);
    }
  }

  /** Continue a saved session: its conversation, its pending tasks, and its turns on screen. */
  private openSession(s: SessionFile) {
    this.conv = new Conversation(s.conversation);
    this.saved = s;
    this.session = new Session();
    restoreTasks(s, this.session);
    this.syncTasks();
    const s0 = this.store;
    s0.set({ turn: s.conversation.turn, remembering: Boolean(s.conversation.sessionId), usage: undefined });
    s0.add({ kind: "divider", label: `resumed · ${s.title} · ${ago(s.updatedAt)}` });
    const shown = s.conversation.log.slice(-6);
    if (s.conversation.turn > shown.length) s0.add({ kind: "notice", tone: "info", text: `${s.conversation.turn - shown.length} earlier turn(s) not shown; the orchestrator remembers them.` });
    for (const t of shown) {
      s0.add({ kind: "user", text: t.goal, time: new Date(s.updatedAt) });
      if (t.finalText.trim()) s0.add({ kind: "assistant", text: t.finalText, streaming: false });
    }
    const pending = this.session.pending().length;
    s0.add({
      kind: "notice",
      tone: "memory",
      text: `Session ${s.id} resumed: the next message continues the conversation${s.conversation.summary ? " (from its background summary)" : ""}.${pending ? ` ${pending} result(s) still pending: /tasks.` : ""}`,
    });
  }

  /** `/sessions [all|here]`: this repo's sessions (or every repo's, or this folder's). */
  listSessionsCommand(arg = "") {
    const all = arg === "all";
    const list = listSessions(all ? {} : arg === "here" ? { root: this.o.root, folder: this.o.folder ?? this.o.root } : { root: this.o.root });
    if (!list.length) return this.note(all ? "No sessions yet." : "No sessions in this repository yet. `/sessions all` lists every repository's.", "info");
    const rows = list.slice(0, 25).map((s) => `- ${s.id === this.saved.id ? "▸ " : ""}\`${s.id}\` ${describeSession(s, all).slice(s.id.length + 2)}`);
    this.note([`**Sessions**${all ? " (all repositories)" : arg === "here" ? " (this folder)" : ""}`, ...rows, list.length > 25 ? `- … ${list.length - 25} more` : "", "", "`/resume <id>` continues one here; sessions of other repositories: `yxu resume <id>` from anywhere."].filter((l, i, a) => l || i === a.length - 2).join("\n"));
  }

  /** `/resume <id|last>`: switch to a saved session of this repository. */
  resumeCommand(ref = "") {
    const st = this.store.state;
    if (st.status === "working" || st.status === "cancelling") return this.flash("an operation is running — resume after it finishes", 2500);
    let s: SessionFile;
    try {
      s = findSession(ref || "last", this.o.root);
    } catch (e) {
      return this.fail((e as Error).message, "/sessions lists them");
    }
    if (!samePath(s.root, this.o.root)) return this.fail(`session ${s.id} belongs to ${tildePath(s.root)}`, `run \`yxu resume ${s.id}\` (it switches there)`);
    if (s.id === this.saved.id) return this.note("That is this session.", "info");
    this.stopBackgroundCompaction();
    this.persist();
    this.clearView();
    this.openSession(s);
  }

  /** `/rename <title>` for this session. */
  renameSession(title: string) {
    if (!title.trim()) return this.note(`This session: ${this.saved.title || "(untitled until its first message)"} · ${this.saved.id}`);
    this.saved.title = titleFrom(title);
    this.persist();
    this.note(`Session renamed: ${this.saved.title}`, "ok");
  }

  private mapping?: Promise<RepoMap | undefined>;

  /** Bring the repo map up to date in the background (only changed files are read). */
  refreshMap(): Promise<RepoMap | undefined> {
    if (!this.cfg.context.repo_map) return Promise.resolve(undefined);
    this.mapping ??= buildRepoMap(this.o.root, { yieldEvery: 200 })
      .catch(() => undefined)
      .finally(() => (this.mapping = undefined));
    return this.mapping;
  }

  /** `/map [query]`: the overview, or what the map finds for a query. */
  async showMap(query: string) {
    const map = (await this.refreshMap()) ?? loadRepoMap(this.o.root);
    if (!map) return this.fail(this.cfg.context.repo_map ? "no repo map: this repository has no commits yet" : "the repo map is off (context.repo_map)");
    const n = Object.keys(map.files).length;
    if (!query.trim()) return this.note(`**Repo map** — ${n} files at ${map.head.slice(0, 8)}, shared with every agent\n\n${overviewText(map)}\n\n\`/map <words>\` shows what a task about them would get.`);
    const slice = mapSlice(map, query, { chars: 4000, noOverview: true });
    this.note(slice.includes("Likely relevant") ? slice.replace(/^## .*\n/, `**Repo map** for "${query}"\n`) : `Nothing in the repo map matches "${query}".`);
  }

  /** `/pr [task] [--draft] [--base B] [--title …]`, or [p] at a decision: push and open a pull request. */
  pullRequest(id: string, o: OpenPrOptions = {}) {
    const gh = this.backend.github;
    if (!gh) return this.fail("pull requests aren't available here");
    try {
      this.store.add({ kind: "notice", tone: "info", text: `Opening a pull request for ${id}…` });
      this.o.invalidate?.();
      const url = gh.pullRequest(id, o);
      this.store.add({ kind: "notice", tone: "ok", text: `Pull request: ${url}` });
    } catch (e) {
      this.fail((e as Error).message, "check `gh auth status`, or the task id (/tasks)");
    }
  }

  /** The issue a run is for: its tasks are tagged so a pull request closes it. */
  private runIssue?: IssueRef;

  /** `/issue <ref> [more instructions]`: work on an issue. */
  async startIssue(ref: string) {
    const gh = this.backend.github;
    if (!gh) return this.fail("issues aren't available here");
    if (!ref.trim()) return this.fail("usage: /issue <123 | owner/repo#123 | url | linear:ENG-12> [more instructions]");
    let got: { goal: string; issue: IssueRef };
    try {
      got = await gh.issue(ref.trim());
    } catch (e) {
      return this.fail((e as Error).message, "check `gh auth status`; trackers like linear: come from plugins");
    }
    this.runIssue = got.issue;
    this.store.add({ kind: "notice", tone: "info", text: `Issue ${got.issue.id}: ${got.issue.title}${got.issue.url ? ` (${got.issue.url})` : ""}` });
    this.startGoal(got.goal);
  }

  /** `/fix-ci <pr>`: the debugger fixes a PR's failing CI; asks before pushing. */
  async fixCi(pr: string, agent?: string) {
    const gh = this.backend.github;
    if (!gh) return this.fail("CI fixes aren't available here");
    if (!pr) return this.fail("usage: /fix-ci <pr number or url> [agent]");
    const st = this.store.state;
    if (st.status === "working" || st.status === "cancelling") return this.flash("an operation is running — esc cancels it", 2500);
    this.store.setStatus("working", `fixing CI of ${pr}`);
    this.startTicker();
    this.abort = new AbortController();
    try {
      const r = await gh.fixCi(pr, {
        agent,
        signal: this.abort.signal,
        hooks: this.renderAdapter().hooks,
        print: (l) => this.store.add({ kind: "notice", tone: "info", text: l }),
        confirmPush: (m) => this.askGate(m, "push"),
      });
      this.syncTasks();
      this.store.add(r.status === "failed" ? { kind: "error", message: r.message } : { kind: "notice", tone: r.status === "fixed" ? "ok" : "info", text: r.message });
    } catch (e) {
      this.fail((e as Error).message);
    } finally {
      this.stopTicker();
      this.abort = undefined;
    }
    if (this.store.state.status === "working") this.settle();
  }

  private showDiff(id: string) {
    const diff = this.backend.diff(id);
    if (!diff) {
      this.store.add({ kind: "notice", tone: "info", text: `Task ${id} has no changes to show.` });
      return;
    }
    this.store.add({ kind: "diff", taskId: id, text: diff });
    this.store.set({ scroll: 0 });
  }

  private async applyTask(id: string) {
    const pending = this.backend.apply(id);
    if (pending instanceof Promise) this.store.setStatus("working", "before_apply hooks");
    const r = await pending;
    if (pending instanceof Promise && this.store.state.status === "working") this.store.setStatus("ready");
    if (r.ok) {
      this.refreshMap(); // HEAD moved
      this.store.add({ kind: "notice", tone: "ok", text: `Applied. ${r.message}.` });
      for (const t of this.store.state.tasks) if (t.taskId === id) this.store.upsertTask({ ...t, state: "applied", pending: false });
      this.discardTracked(id, true);
    } else {
      this.store.add({ kind: "error", message: r.message, hint: "hint" in r ? r.hint : undefined });
      this.store.setStatus("fault", "apply failed");
    }
  }

  private discardTask(id: string) {
    const r = this.backend.discard(id);
    if (r.ok) {
      this.store.add({ kind: "notice", tone: "info", text: `Discarded ${id}.` });
      for (const t of this.store.state.tasks) if (t.taskId === id) this.store.upsertTask({ ...t, state: "discarded", pending: false });
      this.discardTracked(id, false);
    } else {
      this.store.add({ kind: "error", message: r.message });
    }
  }

  /** Keep the in-memory session consistent after apply/discard outside the orchestrator. */
  private discardTracked(id: string, includeAncestors: boolean) {
    const t = this.session.tasks.get(id);
    if (!t) return;
    t.discarded = true;
    if (includeAncestors) {
      const walk = (tid: string) => {
        for (const p of this.session.tasks.get(tid)?.parents ?? []) {
          const pt = this.session.tasks.get(p);
          if (pt && !pt.discarded) {
            pt.discarded = true;
            walk(p);
          }
        }
      };
      walk(id);
    }
  }

  // ── misc ───────────────────────────────────────────────────────────────────

  quit() {
    if (this.abort) this.cancel();
    const pending = this.session.tips().filter((t) => this.backend.exists(t.taskId)).map((t) => ({ taskId: t.taskId, agent: t.agent }));
    this.dispose();
    this.o.exit({ pending });
  }

  private contextInfo(): ContextInfo {
    const { root } = this.o;
    const cfg = this.cfg;
    const branch = tryGit(root, "branch", "--show-current").out;
    return {
      root,
      branch,
      configSource: cfg.source,
      workflow: this.workflow?.name ?? "default",
      mode: this.workflow?.mode ?? "auto",
      model: orchestratorLabel(cfg),
      agents: (this.workflow?.allowed_agents ?? Object.keys(cfg.agents)).map((name) => ({ name, cli: cfg.agents[name]!.cli, model: cfg.agents[name]!.model })),
      concurrency: cfg.settings.concurrency,
      verify: cfg.settings.verify,
      memory: cfg.context.memory,
      projectInstructions: cfg.context.project_instructions,
      include: [...cfg.context.include],
      hasNotes: !!cfg.context.notes?.trim(),
      compact: { auto: cfg.compact.auto, window: cfg.compact.window, warnAt: cfg.compact.warn_at, background: cfg.compact.background },
    };
  }

  private historyPath(): string | null {
    if (this.o.historyFile === null) return null;
    return this.o.historyFile ?? join(this.o.root, ".yxu", "history.jsonl");
  }

  private loadHistory(): string[] {
    const p = this.historyPath();
    if (!p || !existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-200)
      .map((l) => {
        try {
          return String(JSON.parse(l));
        } catch {
          return "";
        }
      })
      .filter(Boolean);
  }

  private saveHistory(entry: string) {
    const p = this.historyPath();
    if (!p) return;
    try {
      excludeYxuDir(this.o.root);
      mkdirSync(join(p, ".."), { recursive: true });
      appendFileSync(p, `${JSON.stringify(entry)}\n`);
    } catch {
      // history is best-effort
    }
  }
}

function firstLine(s: string, max = 70): string {
  const l = (s ?? "").trim().split("\n")[0] ?? "";
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

const shortTask = (id: string) => id.slice(id.lastIndexOf("-") + 1);

/** What an agent has changed so far, without touching its git index. */
export function worktreeChanges(wt: string): { files: { path: string; added: number; removed: number }[]; tail: string[] } {
  const files: { path: string; added: number; removed: number }[] = [];
  for (const line of tryGit(wt, "diff", "--numstat", "HEAD").out.split("\n")) {
    const [a, d, path] = line.split("\t");
    if (path) files.push({ path, added: Number(a) || 0, removed: Number(d) || 0 });
  }
  const untracked = tryGit(wt, "ls-files", "--others", "--exclude-standard").out.split("\n").filter(Boolean);
  let newText: string[] = [];
  for (const path of untracked.slice(0, 20)) {
    let text = "";
    try {
      text = readFileSync(join(wt, path), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").filter((l, i, all) => l || i < all.length - 1);
    files.push({ path, added: lines.length, removed: 0 });
    newText = lines.map((l) => `+${l}`);
  }
  const diff = tryGit(wt, "diff", "HEAD").out.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  return { files, tail: (diff.length ? diff : newText).slice(-12) };
}

/** Open a folder in a graphical editor, if one is around. Returns its name. */
function openEditor(dir: string): string | undefined {
  const gui = ["code", "cursor", "zed", "subl", "idea", "webstorm", "fleet"];
  const fromEnv = process.env.YXU_EDITOR ?? process.env.VISUAL;
  const bin = fromEnv && gui.includes(fromEnv.split(/[\\/]/).at(-1)!.split(" ")[0]!) ? fromEnv.split(" ")[0]! : gui.find((g) => which(g));
  if (!bin || !which(bin)) return undefined;
  try {
    const child = spawn(bin, [dir], { detached: true, stdio: "ignore" });
    child.unref();
    return bin.split(/[\\/]/).at(-1);
  } catch {
    return undefined;
  }
}
