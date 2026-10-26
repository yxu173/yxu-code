/**
 * The orchestrator's settings by friendly name, for `/orchestrator` and `yxu orchestrator`:
 * each field maps to a config key, parses and checks a value, and says what it is now.
 */
import type { Config } from "./config.ts";
import { display, loadLayers, originOf } from "./config-layers.ts";
import { promptOverrides } from "./prompts.ts";

export interface Setting {
  path: string[];
  /** Live value (undefined removes the setting). */
  value: unknown;
  /** How it is written to a file (null removes it from lower layers too); default: value. */
  yaml?: unknown;
}

export interface FieldChange {
  sets: Setting[];
  /** The conversation can't continue across this change (another model or provider). */
  fresh?: boolean;
  /** Said after the change. */
  message: string;
  warning?: string;
}

export interface Field {
  name: string;
  key: string;
  usage: string;
  about: string;
  /** Values offered for completion. */
  values?: (cfg: Config) => { value: string; description?: string }[];
  show(cfg: Config): string;
  set(cfg: Config, value: string, more: string[]): FieldChange | string;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const onOff = (v: string) => (/^(on|true|yes)$/i.test(v) ? true : /^(off|false|no)$/i.test(v) ? false : undefined);

export function providers(cfg: Config): string[] {
  return ["claude", "agent", ...(cfg.plugins ? [...cfg.plugins.orchestrators.keys()] : [])];
}

export const ORCHESTRATOR_FIELDS: Field[] = [
  {
    name: "model",
    key: "orchestrator.model",
    usage: "<opus|sonnet|haiku|model id>",
    about: "the Claude model that plans, delegates and reviews",
    show: (c) => c.orchestrator.model,
    set: (_c, v) => (v ? { sets: [{ path: ["orchestrator", "model"], value: v }], fresh: true, message: `Orchestrator model: ${v}. The next message starts a fresh conversation` } : "usage: model <name>"),
  },
  {
    name: "effort",
    key: "orchestrator.effort",
    usage: "<low|medium|high|xhigh|max|default>",
    about: "how hard it thinks",
    values: () => [...EFFORTS.map((value) => ({ value })), { value: "default", description: "let the model decide" }],
    show: (c) => c.orchestrator.effort ?? "default",
    set: (_c, v) =>
      v === "default"
        ? { sets: [{ path: ["orchestrator", "effort"], value: undefined, yaml: null }], message: "Effort: the model's default" }
        : EFFORTS.includes(v)
          ? { sets: [{ path: ["orchestrator", "effort"], value: v }], message: `Effort: ${v}` }
          : "usage: effort low|medium|high|xhigh|max|default",
  },
  {
    name: "budget",
    key: "orchestrator.max_budget_usd",
    usage: "<usd|off>",
    about: "stop a run when the orchestrator has spent this much",
    values: () => ["1", "5", "10", "off"].map((value) => ({ value })),
    show: (c) => (c.orchestrator.max_budget_usd === undefined ? "none" : `$${c.orchestrator.max_budget_usd} per run`),
    set: (_c, v) => {
      if (v === "off") return { sets: [{ path: ["orchestrator", "max_budget_usd"], value: undefined, yaml: null }], message: "No orchestrator budget" };
      const n = Number(v.replace("$", ""));
      return n > 0 ? { sets: [{ path: ["orchestrator", "max_budget_usd"], value: n }], message: `Orchestrator budget: $${n} per run` } : "usage: budget <usd>|off";
    },
  },
  {
    name: "turns",
    key: "orchestrator.max_turns",
    usage: "<n|off>",
    about: "turn limit per run",
    values: () => ["50", "100", "200", "off"].map((value) => ({ value })),
    show: (c) => (c.orchestrator.max_turns === undefined ? "no limit" : String(c.orchestrator.max_turns)),
    set: (_c, v) => {
      if (v === "off") return { sets: [{ path: ["orchestrator", "max_turns"], value: undefined, yaml: null }], message: "No orchestrator turn limit" };
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? { sets: [{ path: ["orchestrator", "max_turns"], value: n }], message: `Orchestrator turn limit: ${n}` } : "usage: turns <n>|off";
    },
  },
  {
    name: "provider",
    key: "orchestrator.provider",
    usage: "<claude|agent [name]|plugin>",
    about: "who answers pipeline plan and review steps (auto workflows need claude)",
    values: (c) => providers(c).map((value) => ({ value, description: value === "claude" ? "Claude Code (default)" : value === "agent" ? "one of your agents (no Claude needed)" : "from a plugin" })),
    show: (c) => (c.orchestrator.provider === "agent" ? `agent (${c.orchestrator.agent})` : c.orchestrator.provider),
    set: (c, v, more) => {
      if (!providers(c).includes(v)) return `provider must be ${providers(c).join(", ")}`;
      if (v === "agent") {
        const a = more[0] ?? c.orchestrator.agent;
        if (!a) return "usage: provider agent <agent name> (the agent that plans and reviews)";
        if (!c.agents[a]) return `no agent "${a}"`;
        return {
          sets: [
            { path: ["orchestrator", "provider"], value: "agent" },
            { path: ["orchestrator", "agent"], value: a },
          ],
          fresh: true,
          message: `Pipelines now plan and review with ${a}`,
          warning: "Auto workflows (like default) still need provider claude; use a pipeline such as feature.",
        };
      }
      return { sets: [{ path: ["orchestrator", "provider"], value: v }], fresh: true, message: `Orchestrator provider: ${v}`, warning: v === "claude" ? undefined : "Auto workflows (like default) need provider claude; use a pipeline." };
    },
  },
  {
    name: "agent",
    key: "orchestrator.agent",
    usage: "<agent name>",
    about: "the agent that plans and reviews when provider is agent",
    values: (c) => Object.keys(c.agents).map((value) => ({ value })),
    show: (c) => c.orchestrator.agent ?? "none",
    set: (c, v) => (c.agents[v] ? { sets: [{ path: ["orchestrator", "agent"], value: v }], message: `Orchestrator agent: ${v}${c.orchestrator.provider === "agent" ? "" : " (used once provider is agent)"}` } : `no agent "${v}"`),
  },
  {
    name: "user-settings",
    key: "orchestrator.user_settings",
    usage: "<on|off>",
    about: "load your global Claude settings, plugins and MCP servers (costly)",
    values: () => [{ value: "on" }, { value: "off" }],
    show: (c) => (c.orchestrator.user_settings ? "on" : "off"),
    set: (_c, v) => {
      const b = onOff(v);
      return b === undefined
        ? "usage: user-settings on|off"
        : { sets: [{ path: ["orchestrator", "user_settings"], value: b }], fresh: true, message: `Your global Claude settings: ${b ? "loaded (plugins and MCP servers add tokens to every call)" : "not loaded"}` };
    },
  },
  {
    name: "instructions",
    key: "context.notes",
    usage: "<text|clear>",
    about: "standing instructions it follows on every run",
    values: () => [{ value: "clear", description: "remove them" }],
    show: (c) => (c.context.notes?.trim() ? c.context.notes.trim() : "none"),
    set: (_c, v, more) => {
      const text = [v, ...more].join(" ").trim();
      if (!text) return "usage: instructions <text>|clear";
      return text === "clear"
        ? { sets: [{ path: ["context", "notes"], value: undefined, yaml: null }], message: "No standing instructions" }
        : { sets: [{ path: ["context", "notes"], value: text }], message: "Standing instructions updated: they apply from the next message" };
    },
  },
];

export const fieldNamed = (name: string) => ORCHESTRATOR_FIELDS.find((f) => f.name === name || f.key === name);

/** Every setting, its value, and where it comes from; plus the prompt and how to change things. */
export function orchestratorReport(cfg: Config, root: string, o: { unsaved?: Set<string>; markdown?: boolean; sets?: string[] } = {}): string[] {
  let loaded: ReturnType<typeof loadLayers> | undefined;
  try {
    loaded = loadLayers(root, { sets: o.sets });
  } catch {
    loaded = undefined;
  }
  const code = (s: string) => (o.markdown ? `\`${s}\`` : s);
  const rows = ORCHESTRATOR_FIELDS.map((f) => {
    const from = o.unsaved?.has(f.key) ? "this session, unsaved" : loaded ? originLabel(originOf(loaded, f.key, root)) : "";
    const value = f.show(cfg).split("\n")[0]!;
    return `${o.markdown ? "- **" : "  "}${f.name}${o.markdown ? "**" : ""}${o.markdown ? " " : "".padEnd(Math.max(1, 14 - f.name.length))}${code(value.length > 70 ? `${value.slice(0, 69)}…` : value)}${from ? `  · ${from}` : ""}${o.markdown ? ` — ${f.about}` : ""}`;
  });
  const over = promptOverrides(root, "orchestrator");
  const promptLine = `${o.markdown ? "- **prompt** " : "  prompt        "}built-in${over.length ? ` + ${over.map((x) => `${x.mode} ${display(x.file, root)}`).join(", ")}` : ""}${o.markdown ? " — see it with `/orchestrator prompt`; change it in .yxu/prompts/orchestrator.md (team) or ~/.config/yxu/prompts/orchestrator.md (you)" : ""}`;
  return [...rows, promptLine];
}

function originLabel(o: { layer: string; file?: string }): string {
  return o.layer === "defaults" ? "default" : o.file ?? o.layer;
}
