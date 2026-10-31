import type { DiffStat } from "../actions.ts";
import type { ContextUsage } from "../context.ts";
import type { PaletteState } from "./commands.ts";

/** What the machine is doing right now. Each has a glyph and a word in the header. */
export type Status = "ready" | "working" | "deciding" | "complete" | "fault" | "cancelling";

export type ActivityState = "running" | "ok" | "failed" | "skipped";

interface Base {
  id: number;
  /** Bumped on every change; the view caches rendered rows per (id, version, width). */
  version: number;
}

export type Entry = Base &
  (
    | { kind: "user"; text: string; time: Date; images?: string[] }
    | { kind: "assistant"; text: string; streaming: boolean }
    | {
        kind: "activity";
        category: "delegate" | "combine" | "verify" | "read" | "discard" | "tool" | "shell";
        title: string;
        /** Short facts shown on the collapsed row, e.g. "37s · calc.py". */
        meta: string;
        state: ActivityState;
        details: string[];
        expanded: boolean;
        taskId?: string;
        startedAt: number;
      }
    | { kind: "step"; index: number; total: number; name: string; type: string }
    | { kind: "notice"; text: string; tone: "info" | "ok" | "memory" | "attention" }
    | { kind: "error"; message: string; hint?: string }
    | { kind: "diff"; taskId: string; text: string }
    | { kind: "divider"; label: string }
  );

export type EntryKind = Entry["kind"];
type EntryOf<K extends EntryKind> = Extract<Entry, { kind: K }>;
/** An entry before the store assigns id/version (distributes over the union). */
export type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, "id" | "version"> : never) : never;

/** A running agent, live: what it does and what it has changed so far. */
export interface WatchView {
  taskId: string;
  agent: string;
  model?: string;
  /** running · paused · steering · user (taken over) · finished */
  state: string;
  startedAt: number;
  /** Tool calls and messages, newest last. */
  activity: string[];
  /** What the user did: messages sent, pauses, take-over. */
  log: string[];
  files: { path: string; added: number; removed: number }[];
  diffTail: string[];
  /** Follow whichever agent is running (no task named). */
  follow: boolean;
}

export interface TaskView {
  taskId: string;
  agent: string;
  state: "running" | "ok" | "failed" | "discarded" | "applied";
  title: string;
  files: number;
  pending: boolean;
}

export interface Decision {
  taskId: string;
  agent: string;
  stat: DiffStat;
  includes: number;
  /** Other pending results, if the run left several. */
  others: string[];
}

export interface ContextInfo {
  root: string;
  branch: string;
  /** Orchestrator reasoning effort, when set. */
  effort?: string;
  /** How much runs without asking: ask, auto, full. */
  access?: "ask" | "auto" | "full";
  configSource: string;
  workflow: string;
  mode: string;
  model: string;
  agents: { name: string; cli: string; model?: string }[];
  concurrency: number;
  verify?: string;
  /** Live context/compaction settings (editable with /context and /compact). */
  memory: boolean;
  projectInstructions: boolean;
  include: string[];
  hasNotes: boolean;
  compact: { auto: boolean; window: number | "auto"; warnAt: number; background: boolean };
}

export interface State {
  entries: Entry[];
  status: Status;
  statusNote: string;
  /** When the current operation started (for the elapsed timer). */
  since?: number;
  decision?: Decision;
  /** A workflow gate step waiting for the user's answer. */
  gate?: { message: string; stepId: string };
  /** An agent asking to use a tool; `waiting` more questions are queued behind it. */
  approval?: { message: string; agent: string; waiting: number };
  context: ContextInfo;
  tasks: TaskView[];
  activeSlots: number;
  cost: { orchestrator: number; subagents: number };
  /** True when the next message continues the same orchestrator conversation. */
  remembering: boolean;
  turn: number;
  /** Last reported context-window usage of the orchestrator conversation. */
  usage?: ContextUsage;
  /** A copy of the conversation is being compacted in the background. */
  compactingInBackground?: boolean;
  /** The agent being watched in the side panel (/watch). */
  watch?: WatchView;
  /** Images waiting to go with the next message (ctrl+v, /image, a dropped file). */
  attachments?: { path: string; name: string; bytes: number }[];
  /** This repo's recent sessions, offered on the welcome screen. */
  recent?: { id: string; title: string; turns: number; ago: string; pending?: number }[];
  /** Slash-command palette, open while the draft starts with "/". */
  palette?: PaletteState;
  /** Rows scrolled up from the bottom; 0 follows new output. */
  scroll: number;
  /** Activity entry selected for expand/collapse (id), if any. */
  selected?: number;
  panelOpen: boolean;
  helpOpen: boolean;
  /** Panel sections in order, and whether the key-hint footer shows (ui.* config). */
  layout?: { sections: string[]; footer: boolean };
  /** Side-panel sections from plugins, by id "<plugin>:<title>". */
  pluginPanels?: { id: string; title: string; lines: string[] }[];
  /** Custom commands from .yxu/commands, for help: [usage, description]. */
  customHelp?: [string, string][];
  /** Rows scrolled down in the help overlay. */
  helpScroll?: number;
  /** Transient footer message (e.g. "press ctrl+c again to exit"). */
  flash?: string;
  demo: boolean;
}

export class Store {
  state: State;
  private nextId = 1;
  private listeners = new Set<() => void>();

  constructor(context: ContextInfo, opts: { demo?: boolean; panelOpen?: boolean } = {}) {
    this.state = {
      entries: [],
      status: "ready",
      statusNote: "",
      context,
      tasks: [],
      activeSlots: 0,
      cost: { orchestrator: 0, subagents: 0 },
      remembering: false,
      turn: 0,
      scroll: 0,
      panelOpen: opts.panelOpen ?? true,
      helpOpen: false,
      demo: opts.demo ?? false,
    };
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) fn();
  }

  add<N extends NewEntry>(entry: N): EntryOf<N["kind"]> {
    const e = { ...entry, id: this.nextId++, version: 0 } as unknown as EntryOf<N["kind"]>;
    this.state.entries.push(e);
    this.changed();
    return e;
  }

  update<E extends Entry>(entry: E, patch: Partial<Omit<E, "id" | "version" | "kind">>) {
    Object.assign(entry, patch);
    entry.version++;
    this.changed();
  }

  set(patch: Partial<State>) {
    Object.assign(this.state, patch);
    this.changed();
  }

  setStatus(status: Status, note = "") {
    const since = status === "working" ? (this.state.status === "working" ? this.state.since : Date.now()) : undefined;
    this.set({ status, statusNote: note, since });
  }

  /** The newest activity entries first — used for selection. */
  activities(): EntryOf<"activity">[] {
    return this.state.entries.filter((e): e is EntryOf<"activity"> => e.kind === "activity");
  }

  upsertTask(t: TaskView) {
    const i = this.state.tasks.findIndex((x) => x.taskId === t.taskId);
    if (i === -1) this.state.tasks.push(t);
    else this.state.tasks[i] = { ...this.state.tasks[i]!, ...t };
    this.changed();
  }
}
