import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyTask, diffStat, discardTask } from "../actions.ts";
import { readTaskRecord } from "../combine.ts";
import { getWorkflow, type Config, type Workflow } from "../config.ts";
import { branchFor, excludeYxuDir, tryGit } from "../git.ts";
import { Session } from "../ops.ts";
import { runPipeline } from "../orchestrator/pipeline.ts";
import { compactConversation, runOrchestrator, type OrchestratorRender, type RunOutcome } from "../orchestrator/run.ts";
import { saveConfigPatch } from "../config-edit.ts";
import { display, FILE_LAYERS, LAYERS, loadLayers, originOf, type FileLayer } from "../config-layers.ts";
import { explainRows } from "../config-explain.ts";
import { COMMANDS, findCommand, onOff, paletteFor, parseCommandLine } from "./commands.ts";
import { buildContextPrompt, formatTokens, parseTokensArg, resolveInclude, type ContextUsage } from "../context.ts";
import { killAllSubagents } from "../runner.ts";
import type { TaskResult } from "../types.ts";
import { Editor } from "./editor.ts";
import { KeyParser, type Key } from "./keys.ts";
import { Store, type ContextInfo, type Entry, type TaskView } from "./model.ts";
import { recoveryHint } from "./recovery.ts";
import { createTheme, type Theme } from "./theme.ts";
import { ModelCatalog } from "../models.ts";
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
    /** The live config (context/compact settings can change during a session). */
    cfg: Config;
  }): Promise<RunOutcome>;
  /** Summarize the remembered orchestrator conversation now. Optional: not every engine can. */
  compact?(opts: { cfg: Config; sessionId: string; instructions?: string; abort: AbortController; render: OrchestratorRender }): Promise<CompactResult>;
}

export type CompactResult = Awaited<ReturnType<typeof compactConversation>>;

/** Git-side operations on task results. Swappable so tests and the demo never touch real branches. */
export interface TaskBackend {
  exists(id: string): boolean;
  diff(id: string): string;
  apply(id: string): ReturnType<typeof applyTask>;
  discard(id: string): ReturnType<typeof discardTask>;
}

export function gitBackend(root: string): TaskBackend {
  return {
    exists: (id) => !!tryGit(root, "branch", "--list", branchFor(id)).out,
    diff: (id) => {
      const r = tryGit(root, "diff", `HEAD...${branchFor(id)}`);
      return (r.ok && r.out) || readTaskRecord(root, id)?.diff || "";
    },
    apply: (id) => applyTask(root, id),
    discard: (id) => discardTask(root, id),
  };
}

export function productionEngine(root: string): Engine {
  return {
    run: ({ goal, workflow, render, abort, session, resume, cfg }) =>
      workflow.mode === "pipeline"
        ? runPipeline({ goal, cfg, workflow, root, render, abort, session })
        : runOrchestrator({ goal, cfg, workflow, root, render, abort, session, resume }),
    compact: ({ cfg, sessionId, instructions, abort, render }) => compactConversation({ cfg, root, sessionId, instructions, abort, render }),
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
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const HOOKED_TOOLS = new Set(["delegate", "combine", "discard", "verify", "StructuredOutput", "delegate_parallel"]);

export class App {
  readonly store: Store;
  readonly editor: Editor;
  private parser = new KeyParser();
  private workflow: Workflow & { name: string };
  private session = new Session();
  private sdkSessionId?: string;
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
    this.theme = o.theme;
    this.catalog = o.catalog ?? new ModelCatalog();
    // When a model list arrives, refresh an open palette that is waiting for it.
    this.catalog.onChange(() => {
      if (this.store.state.palette) this.updatePalette();
    });
    this.workflow = getWorkflow(this.cfg, o.workflow);
    this.backend = o.backend ?? gitBackend(o.root);
    this.store = new Store(this.contextInfo(), { demo: o.demo, panelOpen: true });
    this.editor = new Editor(this.loadHistory());
    this.store.subscribe(() => this.requestRender());
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
    clearInterval(this.ticker);
    clearTimeout(this.flashTimer);
    clearTimeout(this.escTimer);
    this.abort?.abort();
  }

  // ── keys ───────────────────────────────────────────────────────────────────

  private paletteDismissed = false;

  key(k: Key) {
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
    const cmd = findCommand(p.mode === "command" ? item.value : (p.command ?? ""));
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
      if (k.name === "escape" || (k.name === "char" && k.text === "?") || k.name === "enter") this.store.set({ helpOpen: false });
      else if (k.name === "char" && k.ctrl && k.text === "c") this.store.set({ helpOpen: false });
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

    // Decision keys act only when the draft is empty, so typing a follow-up still works.
    if (st.status === "deciding" && e.isEmpty && k.name === "char" && !k.ctrl && !k.alt) {
      const t = k.text?.toLowerCase();
      if (t === "a") return void this.decide("apply");
      if (t === "v") return void this.decide("view");
      if (t === "l") return void this.decide("later");
      if (t === "x") return void this.decide("discard");
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
    const cmd = findCommand(name);
    if (!cmd) {
      const shared = (c: string) => [...name].findIndex((ch, i) => c[i] !== ch) >>> 0; // common prefix length
      const near = COMMANDS.filter((c) => c.name.startsWith(name.slice(0, 2)))
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
    this.dirty.set(path.join("."), { path, value: yamlValue });
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
      const files = loaded.layers.filter((l) => l.file).map((l) => `- ${l.name}: ${display(l.file!, this.o.root)}${l.exists ? "" : " (none)"}`);
      const rows = explainRows(loaded, this.o.root, key);
      if (key && !rows.length) return this.fail(`no setting "${key}"`, "try /config with no key to list everything");
      const unsaved = this.dirty.size ? [`*${this.dirty.size} unsaved session change${this.dirty.size === 1 ? "" : "s"} (not shown) — /save [user|project|local]*`] : [];
      this.note(["**Config layers** (later wins)", ...files, "", ...rows.map((r) => `- \`${r.key}\` = ${r.value} · ${r.from}`), ...unsaved].join("\n"));
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  setTheme(opts: { ascii?: boolean; reducedMotion?: boolean }) {
    this.theme = createTheme({
      depth: this.theme.depth,
      ascii: opts.ascii ?? this.theme.ascii,
      reducedMotion: opts.reducedMotion ?? this.theme.reducedMotion,
      paintBackground: this.theme.paintBackground,
    });
    this.o.invalidate?.();
    this.store.changed();
  }

  /** Forget the remembered orchestrator conversation (next message starts fresh). */
  resetConversation() {
    this.sdkSessionId = undefined;
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
      const bits = [a.cli, a.model, a.permission ?? (a.cli === "claude" ? "accept-edits" : "yolo"), a.timeout ? `timeout ${Math.round(a.timeout / 60000)}m` : "", a.max_turns ? `${a.max_turns} turns` : ""].filter(Boolean);
      return `- **${n}** — ${bits.join(" · ")}${a.description ? `. ${a.description}` : ""}`;
    });
    this.note(`Agents (up to ${this.cfg.settings.concurrency} at once${this.cfg.settings.resolver ? `, resolver ${this.cfg.settings.resolver}` : ""}):\n${lines.join("\n")}\n\nChange with \`/agent <name> model|timeout|permission|turns <value>\`.`);
  }

  listTasks() {
    const ts = this.store.state.tasks;
    this.note(ts.length ? ts.map((t) => `${t.taskId}  ${t.agent}  ${t.pending ? "pending" : t.state}  ${t.title}`).join("\n") : "No tasks in this session yet.");
  }

  taskAction(kind: "diff" | "apply" | "discard", arg?: string) {
    const id = this.resolveTask(arg ?? "");
    if (!id) return this.fail(arg ? `no task matching "${arg}"` : `/${kind} needs a task id`, "type /tasks to list task ids");
    if (kind === "diff") return this.showDiff(id);
    if (kind === "apply") return this.applyTask(id);
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
    const clis = new Set(Object.values(this.cfg.agents).map((a) => a.cli));
    for (const cli of clis) this.catalog.get(cli);
  }

  async showModels(args: string[]): Promise<void> {
    const [target, ...rest] = args;
    const clis: CliName[] = ["commandcode", "opencode", "claude"];
    if (target === "refresh") {
      const used = [...new Set(Object.values(this.cfg.agents).map((a) => a.cli))];
      this.note(`Asking ${used.join(", ")} for their models…`, "info");
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
    const cli: CliName | undefined = (clis as string[]).includes(target) ? (target as CliName) : this.cfg.agents[target]?.cli;
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
    const out: string[] = [`**${cli}** — ${hits.length}${q ? ` of ${st.models.length}` : ""} models${q ? ` matching "${q}"` : ""}`];
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
      default:
        return this.compactNow(args.join(" ").trim() || undefined);
    }
  }

  /** Summarize the remembered orchestrator conversation now. */
  private async compactNow(extra?: string) {
    const s = this.store;
    if (s.state.status === "working" || s.state.status === "cancelling") return this.flash("an operation is running — compact after it finishes", 2500);
    if (!this.o.engine.compact) return void s.add({ kind: "error", message: "this engine cannot compact conversations" });
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
      const c = r.compaction;
      s.update(act, { state: "ok", meta: `${formatTokens(c.preTokens)}${c.postTokens !== undefined ? ` → ${formatTokens(c.postTokens)}` : ""} tokens` });
      this.settle();
    } else {
      s.update(act, { state: "failed", meta: cancelled ? "cancelled" : "failed" });
      if (!cancelled) s.add({ kind: "error", message: `compaction failed: ${err ?? r?.error ?? "unknown error"}`, hint: "the conversation is unchanged; you can keep working or /new to start fresh" });
      s.setStatus(cancelled ? "ready" : "fault", cancelled ? "" : "compaction failed");
    }
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
      `- instructions: ${k.instructions?.trim() ? k.instructions.trim() : "default (task ids, decisions, changed files)"}`,
      "",
      "Change with `/context memory|instructions on|off`, `/context add|drop <file>`, `/context notes <text>`, `/compact auto on|off`, `/compact window <200k|auto>`, `/compact instructions <text>`, `/compact` to summarize now, `/context save` to keep.",
    );
    return lines.join("\n");
  }

  /** Accept a full task id or a unique suffix (the short ids shown in the panel). */
  private resolveTask(arg: string): string | undefined {
    if (!arg) return undefined;
    if (this.store.state.tasks.some((t) => t.taskId === arg) || readTaskRecord(this.o.root, arg)) return arg;
    const matches = this.store.state.tasks.filter((t) => t.taskId.endsWith(arg));
    return matches.length === 1 ? matches[0]!.taskId : undefined;
  }

  // ── runs ───────────────────────────────────────────────────────────────────

  private async startRun(goal: string) {
    const s = this.store;
    s.set({ turn: s.state.turn + 1 });
    const time = new Date();
    s.add({
      kind: "divider",
      label: `${this.sdkSessionId ? "continuing" : "turn"} ${s.state.turn} · ${time.toTimeString().slice(0, 5)}`,
    });
    s.add({ kind: "user", text: goal, time });
    s.setStatus("working", this.workflow.mode === "pipeline" ? `pipeline ${this.workflow.name}` : "orchestrator planning");
    this.startTicker();
    this.abort = new AbortController();
    this.streaming = undefined;
    this.openRead = undefined;

    let outcome: RunOutcome | undefined;
    let thrown: unknown;
    try {
      outcome = await this.o.engine.run({
        goal,
        workflow: this.workflow,
        render: this.renderAdapter(),
        abort: this.abort,
        session: this.session,
        resume: this.cfg.context.memory ? this.sdkSessionId : undefined,
        cfg: this.cfg,
      });
    } catch (e) {
      thrown = e;
    }
    this.stopTicker();
    this.finishStreaming();
    this.markStragglers();
    s.set({ activeSlots: 0 });
    this.syncTasks();

    const cancelled = this.abort.signal.aborted || outcome?.cancelled;
    this.abort = undefined;

    if (outcome) {
      s.state.cost.orchestrator += outcome.costUsd;
      if (outcome.sdkSessionId && this.workflow.mode === "auto" && this.cfg.context.memory) {
        this.sdkSessionId = outcome.sdkSessionId;
        s.set({ remembering: true });
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

  cancel() {
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
        s.add({ kind: "notice", tone: "memory", text: `Conversation compacted (${info.trigger}): ${formatTokens(info.preTokens)}${after} tokens. Memory continues from the summary.` });
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
          s.add({ kind: "step", index, total, name: id, type });
          s.set({ statusNote: `step ${index}/${total} · ${id}` });
        }
      },
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
        onDelegateEnd: (r) => {
          this.finishActivity(r);
          s.state.cost.subagents += r.costUsd ?? 0;
          s.upsertTask({ taskId: r.taskId, agent: r.agent, state: r.ok ? "ok" : "failed", title: this.findActivity(r.taskId)?.title.split("\t")[1] ?? "", files: r.filesChanged.length, pending: !!r.branch });
          slots(-1);
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

  async decide(choice: "apply" | "view" | "later" | "discard") {
    const d = this.store.state.decision;
    if (!d) return;
    if (choice === "view") return this.showDiff(d.taskId);
    if (choice === "later") {
      this.clearDecision(true);
      this.store.setStatus("ready");
      return;
    }
    this.store.set({ decision: undefined });
    if (choice === "apply") this.applyTask(d.taskId);
    else this.discardTask(d.taskId);
    if (!this.offerDecision() && this.store.state.status !== "fault") this.settle();
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

  private applyTask(id: string) {
    const r = this.backend.apply(id);
    if (r.ok) {
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
      model: cfg.orchestrator.model,
      agents: (this.workflow?.allowed_agents ?? Object.keys(cfg.agents)).map((name) => ({ name, cli: cfg.agents[name]!.cli, model: cfg.agents[name]!.model })),
      concurrency: cfg.settings.concurrency,
      verify: cfg.settings.verify,
      memory: cfg.context.memory,
      projectInstructions: cfg.context.project_instructions,
      include: [...cfg.context.include],
      hasNotes: !!cfg.context.notes?.trim(),
      compact: { auto: cfg.compact.auto, window: cfg.compact.window, warnAt: cfg.compact.warn_at },
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
