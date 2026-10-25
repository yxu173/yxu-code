/**
 * `yxu init`: find the agent CLIs on this machine, propose agents (with models from the
 * catalog), pick a starter pack for the project's language, and write a commented yxu.yaml.
 * Interactive in a terminal; `--yes` (or no terminal) takes every suggestion.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { SCHEMA_COMMENT } from "./config.ts";
import { excludeFromGit } from "./config-edit.ts";
import { repoRoot } from "./git.ts";
import { addPack } from "./pack-install.ts";
import { readManifest } from "./packs.ts";
import { runSync, which } from "./platform.ts";
import { builtinPackNames, fetchSource, parseSource } from "./sources.ts";
import { setTrust } from "./trust.ts";
import type { CliName } from "./types.ts";

export interface AgentChoice {
  name: string;
  cli: CliName | "acp";
  bin: string;
  model?: string;
  command?: string[];
  description: string;
}

/** The agents yxu knows how to set up, strongest last (the resolver and escalation target). */
export const KNOWN_AGENTS: AgentChoice[] = [
  { name: "coder", cli: "commandcode", bin: "cmd", model: "deepseek/deepseek-v4-flash", description: "Fast, cheap coder for small well-scoped tasks." },
  { name: "oc-coder", cli: "opencode", bin: "opencode", model: "opencode/deepseek-v4.1-flash-free", description: "OpenCode with a free DeepSeek model; good fallback coder." },
  { name: "gemini", cli: "acp", bin: "gemini", command: ["gemini", "--experimental-acp"], description: "Gemini CLI over ACP; asks before running commands." },
  { name: "claude-coder", cli: "claude", bin: "claude", model: "sonnet", description: "Claude Sonnet for tricky logic, or when the others fail twice." },
];

export interface InitPlan {
  agents: AgentChoice[];
  /** A starter pack to install; it sets the verify command. */
  pack?: string;
  /** Verify command written to yxu.yaml (when no pack sets one). */
  verify?: string;
}

/** Starter packs whose `detect` files exist in the repo, with the file that matched. */
export function detectPacks(root: string): { name: string; file: string; description?: string }[] {
  const out: { name: string; file: string; description?: string }[] = [];
  for (const name of builtinPackNames()) {
    const got = fetchSource(parseSource(name));
    try {
      const m = readManifest(got.path);
      const file = (m.detect ?? []).find((f) => existsSync(join(root, f)));
      if (file) out.push({ name, file, description: m.description });
    } finally {
      got.cleanup();
    }
  }
  return out;
}

/** Guess the project's test command when no starter pack fits. */
export function detectVerify(root: string): string | undefined {
  const has = (f: string) => existsSync(join(root, f));
  if (has("package.json")) {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pkg.scripts?.test) return has("bun.lock") || has("bun.lockb") ? "bun run test" : has("pnpm-lock.yaml") ? "pnpm test" : "npm test";
  }
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py")) return "python -m pytest -q";
  if (has("Makefile") && /^test:/m.test(readFileSync(join(root, "Makefile"), "utf8"))) return "make test";
  return undefined;
}

const q = (s: string) => (/^[\w./@-]+$/.test(s) ? s : JSON.stringify(s));

/** The commented yxu.yaml for a plan. */
export function initYaml(plan: InitPlan): string {
  const agents = plan.agents.length ? plan.agents : [KNOWN_AGENTS[0]!];
  const first = agents[0]!.name;
  const strongest = agents.at(-1)!.name;
  const agentBlocks = agents
    .map((a) => {
      const lines = [`  ${a.name}:`, `    cli: ${a.cli}`];
      if (a.command) lines.push(`    command: [${a.command.map(q).join(", ")}]`);
      if (a.model) lines.push(`    model: ${q(a.model)}`);
      lines.push(`    timeout: ${a.cli === "claude" ? "20m" : "15m"}`, `    description: ${a.description}`);
      return lines.join("\n");
    })
    .join("\n");
  const others = agents.slice(1, -1).map((a) => `\`${a.name}\``);
  const instructions = [
    `Prefer \`${first}\` for small, well-scoped tasks.`,
    ...(others.length ? [`If \`${first}\` is unavailable or fails, use ${others.join(" or ")}.`] : []),
    ...(agents.length > 1 ? [`Escalate to \`${strongest}\` only after another agent has failed twice on the same task.`] : []),
  ];
  const verifyLine = plan.pack
    ? `  # verify comes from the ${plan.pack} pack; set it here to override`
    : plan.verify
      ? `  verify: ${q(plan.verify)}   # checks a result (verify steps and the verify tool)`
      : `  # verify: npm test     # set your test command to enable verify steps`;
  const hasVerify = Boolean(plan.pack || plan.verify);
  return `${SCHEMA_COMMENT}
# yxu configuration, written by \`yxu init\`. Agents are local CLIs; the orchestrator is Claude Code.
# Personal overrides for this repo go in yxu.local.yaml (git-ignored); see \`yxu config\`.
version: 1

orchestrator:
  model: opus            # Claude model that plans, delegates, and reviews
  effort: high
  max_budget_usd: 5      # stop the orchestrator if it spends more than this

agents:
${agentBlocks}
  # permission: accept-edits (default) edits files only · plan: read only
  #             yolo: may run any command without asking (opt in per agent)
  # More agents: \`cli: acp\` for any ACP agent, \`cli: generic\` for any CLI (docs/AGENTS.md).
  # Check one with: yxu agent test <name>

workflows:
  default:
    mode: auto
    instructions: |
${instructions.map((l) => `      ${l}`).join("\n")}

  # A fixed pipeline: plan → implement in parallel →${hasVerify ? " verify (auto-fix) →" : ""} review.
  feature:
    mode: pipeline
    steps:
      - id: plan
        type: plan
        max_tasks: 4
      - id: implement
        type: delegate
        agent: ${first}
        for_each: plan
${hasVerify ? `      - id: verify\n        type: verify\n        fix_agent: ${first}\n` : ""}      - id: review
        type: review
        fix_agent: ${first}
        max_rounds: 2

# What the orchestrator sees. Change live in the TUI with /context; persist with /context save.
context:
  memory: true            # continue the same orchestrator conversation across messages (TUI)
  project_instructions: true  # load CLAUDE.md
  include: []             # files added to the orchestrator's context, e.g. [docs/ARCHITECTURE.md]

# Summarizing long orchestrator conversations. Change live with /compact.
compact:
  auto: true
  window: auto            # or a token count between 100k and 1m, e.g. 200k
  warn_at: 0.8

settings:
  concurrency: 3          # subagents running at the same time
  default_agent: ${first}   # the agent packs' workflows use (agent: default)
  resolver: ${strongest}  # agent that resolves merge conflicts when combining parallel work
${verifyLine}
`;
}

export interface InitOptions {
  yes?: boolean;
  /** A starter pack, or "none". */
  pack?: string;
  /** Agent names from KNOWN_AGENTS to use (skips the questions about agents). */
  agents?: string[];
  force?: boolean;
}

/** Run the wizard (or take every suggestion), write yxu.yaml, and install the starter pack. */
export async function init(o: InitOptions, print: (l: string) => void, dim: (s: string) => string): Promise<void> {
  const root = repoRoot(process.cwd());
  const path = join(root, "yxu.yaml");
  if (existsSync(path) && !o.force) throw new Error(`${path} already exists (--force replaces it)`);
  const interactive = !o.yes && process.stdin.isTTY && process.stdout.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (question: string, def: string) => (rl ? (await rl.question(`${question} ${dim(`[${def}]`)} `)).trim() || def : def);
  const yes = async (question: string, def = true) => {
    if (!rl) return def;
    const a = (await rl.question(`${question} ${dim(def ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
    return a ? a.startsWith("y") : def;
  };
  try {
    print("Agent CLIs on this machine");
    const found = KNOWN_AGENTS.filter((a) => {
      const p = which(a.bin);
      const ver = p ? runSync([a.bin, ...(a.cli === "commandcode" ? ["--version", "--no-auto-update"] : ["--version"])]).stdout.trim().split("\n").at(-1) : "";
      print(p ? `  ✓ ${a.bin.padEnd(9)} ${dim(`${ver ?? ""}  ${p}`)}` : dim(`  · ${a.bin.padEnd(9)} not found`));
      return Boolean(p);
    });
    print("");
    let agents: AgentChoice[] = [];
    if (o.agents) {
      for (const n of o.agents) agents.push(structuredClone(KNOWN_AGENTS.find((a) => a.name === n) ?? (() => { throw new Error(`unknown agent "${n}" (known: ${KNOWN_AGENTS.map((a) => a.name).join(", ")})`); })()));
    } else {
      for (const a of found) {
        if (!(await yes(`Use ${a.name} (${a.cli === "acp" ? a.command!.join(" ") : `${a.bin}${a.model ? ` · ${a.model}` : ""}`})?`))) continue;
        const choice = structuredClone(a);
        if (rl && a.model) choice.model = await pickModel(a, ask, print, dim);
        agents.push(choice);
      }
      if (!agents.length) {
        print(found.length ? "! no agents chosen; writing coder (Command Code) as an example to edit" : "! no agent CLIs found; writing coder (Command Code) as an example to edit");
        agents = [structuredClone(KNOWN_AGENTS[0]!)];
      }
    }

    let pack: string | undefined;
    if (o.pack && o.pack !== "none") pack = parseSource(o.pack).kind === "builtin" ? o.pack : undefined;
    if (o.pack && o.pack !== "none" && !pack) throw new Error(`--pack takes a starter pack (${builtinPackNames().join(", ")}); add other packs with \`yxu add\` afterwards`);
    if (!o.pack) {
      const hits = detectPacks(root);
      for (const h of hits) {
        if (await yes(`This looks like a ${h.name} project (${h.file}). Add the ${h.name} starter pack? ${dim(h.description ?? "")}`)) {
          pack = h.name;
          break;
        }
      }
    }
    let verify: string | undefined;
    if (!pack) {
      const guess = detectVerify(root);
      verify = (await ask("Verify command (empty: none)", guess ?? "")) || undefined;
    }

    writeFileSync(path, initYaml({ agents, pack, verify }));
    excludeFromGit(root, "yxu.local.yaml");
    setTrust(root, true); // you wrote this config, so commands in it may run
    print(`✓ wrote ${path}${verify ? ` (verify: ${verify})` : ""}`);
    if (pack) {
      await addPack(root, pack, { scope: "project" }, { print: () => {}, dim });
      print(`✓ added the ${pack} starter pack (.yxu/packs/${pack}, pinned in yxu.lock)`);
    }
    print(
      [
        "",
        "next:",
        ...[
          [`yxu agent test ${agents[0]!.name}`, "check that an agent works with yxu (and is logged in)"],
          ["yxu doctor", "check the whole setup"],
          ["yxu", "open the interface"],
        ].map(([c, d], _i, all) => `  ${c!.padEnd(Math.max(...all.map((x) => x[0]!.length)) + 3)}${d}`),
        dim("personal overrides: yxu config set <key> <value> --local  (yxu.local.yaml, git-ignored)"),
      ].join("\n"),
    );
  } finally {
    rl?.close();
  }
}

/** Ask for a model: Enter keeps the suggestion, `?` lists what the CLI offers. */
async function pickModel(a: AgentChoice, ask: (q: string, def: string) => Promise<string>, print: (l: string) => void, dim: (s: string) => string): Promise<string | undefined> {
  const { ModelCatalog } = await import("./models.ts");
  const catalog = new ModelCatalog();
  for (;;) {
    const m = await ask(`  model for ${a.name} (? lists them)`, a.model ?? "");
    if (m !== "?") return m || undefined;
    if (catalog.get(a.cli).status !== "ready") await catalog.refresh(a.cli);
    const st = catalog.get(a.cli);
    if (st.status === "error") print(`  ! could not list models: ${st.error}`);
    else for (const x of st.models.slice(0, 40)) print(`    ${x.id}${x.isDefault ? " (default)" : ""}  ${dim(x.description)}`);
    if (st.models.length > 40) print(dim(`    … ${st.models.length - 40} more: yxu models ${a.cli}`));
  }
}
