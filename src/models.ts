/**
 * Model catalog: which models each agent CLI can use, discovered from the CLIs themselves.
 *   commandcode → `cmd --list-models`         (sections + descriptions)
 *   opencode    → `opencode models --verbose` (provider/model + metadata: name, context, cost)
 *   claude      → no list command; Claude Code's documented aliases and model ids
 * Results are cached on disk for a day so the interface never waits on them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { which } from "./platform.ts";
import type { CliName } from "./types.ts";

export interface ModelInfo {
  id: string;
  /** Provider or section, e.g. "deepseek", "Anthropic", "amazon-bedrock". */
  group: string;
  description: string;
  /** Marked as the CLI's default, when it says so. */
  isDefault?: boolean;
}

export const CLAUDE_MODELS: ModelInfo[] = [
  { id: "opus", group: "alias", description: "latest Opus — strongest planning and review" },
  { id: "sonnet", group: "alias", description: "latest Sonnet — fast and capable" },
  { id: "haiku", group: "alias", description: "latest Haiku — fastest, cheapest" },
  { id: "fable", group: "alias", description: "latest Fable" },
  { id: "claude-opus-5-5", group: "Anthropic", description: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", group: "Anthropic", description: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", group: "Anthropic", description: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", group: "Anthropic", description: "Claude Fable 5.1" },
];

/** `cmd --list-models`: section headings followed by "id   description" rows. */
export function parseCommandCodeModels(text: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  let group = "";
  for (const raw of text.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (/^pass the full id/i.test(line.trim())) break; // usage help and non-coding models follow
    if (!line.trim() || /^available models/i.test(line.trim())) continue;
    const m = /^(\S+)\s{2,}(.+)$/.exec(line.trim());
    if (m && /[/\-.:]|\d/.test(m[1]!)) {
      const desc = m[2]!.trim();
      out.push({ id: m[1]!, group, description: desc.replace(/\s*\(default\)\s*$/, ""), isDefault: /\(default\)/.test(desc) || undefined });
    } else if (!line.startsWith(" ")) {
      group = line.trim();
    }
  }
  return out;
}

function money(n: number | undefined): string {
  if (n === undefined) return "?";
  return n === 0 ? "0" : n < 1 ? n.toFixed(2).replace(/0+$/, "") : String(+n.toFixed(2));
}

/** `opencode models --verbose`: "provider/model" lines, each followed by a JSON object. */
export function parseOpencodeModels(text: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!.trim();
    if (!/^[^\s{}"]+\/\S+$/.test(head)) continue;
    // Collect the JSON block that follows (until the next model line).
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length && !/^[^\s{}"]+\/\S+$/.test(lines[j]!.trim())) body.push(lines[j++]!);
    i = j - 1;
    const group = head.slice(0, head.indexOf("/"));
    let meta: { name?: string; status?: string; cost?: { input?: number; output?: number }; limit?: { context?: number } } = {};
    try {
      meta = body.join("\n").trim() ? JSON.parse(body.join("\n")) : {};
    } catch {
      // non-verbose output or partial JSON: keep the id only
    }
    if (meta.status && meta.status !== "active") continue; // deprecated models
    const bits: string[] = [];
    if (meta.name) bits.push(meta.name);
    if (meta.limit?.context) bits.push(`${Math.round(meta.limit.context / 1000)}k ctx`);
    if (meta.cost) {
      const zero = meta.cost.input === 0 && meta.cost.output === 0;
      // $0 is only "free" for OpenCode's own free tier; elsewhere it means no public price
      // (e.g. Azure deployments are billed by your own subscription).
      const free = group === "opencode" || /free/i.test(head) || /free/i.test(meta.name ?? "");
      bits.push(zero ? (free ? "free" : "price not listed") : `$${money(meta.cost.input)}/$${money(meta.cost.output)} per M`);
    }
    out.push({ id: head, group, description: bits.join(" · ") });
  }
  return out;
}

async function run(argv: string[], timeoutMs = 20_000): Promise<string> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0 && !out.trim()) throw new Error(err.trim().split("\n").at(-1) || `exit ${code}`);
  return out + (out.includes("\n") ? "" : err); // some CLIs print the list on stderr
}

/** Ask a CLI for its models. Throws when the CLI is missing or fails. */
export async function discoverModels(cli: CliName): Promise<ModelInfo[]> {
  switch (cli) {
    case "claude":
      return CLAUDE_MODELS;
    case "commandcode":
      if (!which("cmd")) throw new Error("`cmd` not found on PATH");
      return parseCommandCodeModels(await run(["cmd", "--list-models", "--no-auto-update"]));
    case "opencode":
      if (!which("opencode")) throw new Error("`opencode` not found on PATH");
      return parseOpencodeModels(await run(["opencode", "models", "--verbose"]));
  }
}

const DAY = 24 * 60 * 60 * 1000;

interface CacheFile {
  [cli: string]: { fetchedAt: number; models: ModelInfo[] };
}

export function defaultCachePath(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "yxu", "models.json");
}

export type CatalogState = { status: "idle" | "loading" | "ready" | "error"; models: ModelInfo[]; error?: string; fetchedAt?: number };

/** In-memory catalog backed by a disk cache; refreshes stale entries in the background. */
export class ModelCatalog {
  private state = new Map<CliName, CatalogState>();
  private inflight = new Map<CliName, Promise<void>>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly cachePath: string | null = defaultCachePath(),
    private readonly discover: (cli: CliName) => Promise<ModelInfo[]> = discoverModels,
    private readonly maxAgeMs = DAY,
  ) {
    for (const [cli, entry] of Object.entries(this.readCache())) {
      this.state.set(cli as CliName, { status: "ready", models: entry.models, fetchedAt: entry.fetchedAt });
    }
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(cli: CliName): CatalogState {
    // Claude Code has no list command; its models are known up front.
    if (cli === "claude") return { status: "ready", models: CLAUDE_MODELS, fetchedAt: Date.now() };
    const st = this.state.get(cli) ?? { status: "idle", models: [] };
    // Stale or never loaded: start a background refresh, keep serving what we have.
    if (st.status !== "loading" && (!st.fetchedAt || Date.now() - st.fetchedAt > this.maxAgeMs) && st.status !== "error") {
      void this.refresh(cli);
      return this.state.get(cli)!;
    }
    return st;
  }

  /** Re-query the CLI now. Resolves when done (errors are stored, not thrown). */
  refresh(cli: CliName): Promise<void> {
    const pending = this.inflight.get(cli);
    if (pending) return pending;
    const prev = this.state.get(cli);
    this.state.set(cli, { status: "loading", models: prev?.models ?? [], fetchedAt: prev?.fetchedAt });
    this.emit();
    const p = this.discover(cli)
      .then((models) => {
        this.state.set(cli, { status: "ready", models, fetchedAt: Date.now() });
        this.writeCache();
      })
      .catch((e: Error) => {
        this.state.set(cli, { status: "error", models: prev?.models ?? [], error: e.message, fetchedAt: prev?.fetchedAt });
      })
      .finally(() => {
        this.inflight.delete(cli);
        this.emit();
      });
    this.inflight.set(cli, p);
    return p;
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private readCache(): CacheFile {
    if (!this.cachePath || !existsSync(this.cachePath)) return {};
    try {
      return JSON.parse(readFileSync(this.cachePath, "utf8"));
    } catch {
      return {};
    }
  }

  private writeCache() {
    if (!this.cachePath) return;
    const data: CacheFile = {};
    for (const [cli, st] of this.state) if (st.fetchedAt && st.models.length) data[cli] = { fetchedAt: st.fetchedAt, models: st.models };
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(data));
    } catch {
      // cache is best-effort
    }
  }
}
