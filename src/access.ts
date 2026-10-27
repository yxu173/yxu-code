/**
 * How much yxu may do without asking you, for the whole session (settings.permissions):
 *
 *   ask    Ask for approval: yxu asks before agents run commands and before commands in your
 *          checkout (read-only git runs freely).
 *   auto   Approve for me: a classifier (a small, fast Claude model) approves or blocks each
 *          action, and asks you when it's unsure.
 *   full   Full access: every action runs without asking; agents run with yolo permission
 *          (read-only roles stay read-only).
 *
 * The classifier covers what yxu can intercept: commands in your checkout and tool requests from
 * ACP agents. CLI agents (Command Code, OpenCode, Claude) run headless with their own permission
 * setting; full access raises them to yolo.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "./config.ts";
import { claudeExecutable } from "./platform.ts";
import type { Answer, Asker, PermissionRequest } from "./permissions.ts";
import { fromRepo } from "./trust.ts";

export const ACCESS_MODES = ["ask", "auto", "full"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const ACCESS: Record<AccessMode, { label: string; about: string }> = {
  ask: { label: "Ask for approval", about: "yxu asks before agents run commands and before commands in your checkout" },
  auto: { label: "Approve for me", about: "a classifier approves or blocks each action and asks you when unsure" },
  full: { label: "Full access", about: "every action runs without asking, with full access to the repository" },
};

/** The mode in effect. A repo you haven't trusted can't raise it from its own config. */
export function accessMode(cfg: Config): AccessMode {
  const m = (cfg.settings.permissions ?? "ask") as AccessMode;
  if (m !== "ask" && cfg.trusted === false && fromRepo(cfg, "settings.permissions")) return "ask";
  return m;
}

export interface Verdict {
  decision: "allow" | "block" | "ask";
  reason: string;
}

export type Classifier = (req: PermissionRequest, ctx: { goal?: string; root: string }) => Promise<Verdict>;

const LOOK = new Set(["read", "search", "think", "fetch"]);
const READ_ONLY_CMD = /^\s*(git\s+(status|diff|log|show|branch|rev-parse|ls-files|blame|remote(\s+-v)?)|ls|cat|head|tail|wc|grep|rg|find|pwd|echo)\b[^;&|`$<>\n]*$/;
/** Never without a person: destroying data, publishing by force, running downloaded code. */
const DANGEROUS: [RegExp, string][] = [
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\.\.)(\s|$|\/\s*$)/, "deletes a home, root or parent directory"],
  [/\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease\b)/, "force-pushes, which can overwrite others' work"],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z|fi)?sh\b/, "pipes a download into a shell"],
  [/\b(mkfs|fdisk|dd\s+[^|]*of=\/dev\/)/, "writes to a disk device"],
  [/:\(\)\s*\{\s*:\|:&\s*\}\s*;/, "a fork bomb"],
  [/\bchmod\s+-R\s+777\s+\//, "opens permissions on the whole system"],
  [/\b(cat|less|cp|scp|curl)\b[^\n]*(~\/\.ssh|\.ssh\/id_|\.aws\/credentials|\.npmrc|\.netrc)/, "touches credentials"],
];

/** Decisions that need no model: looking is fine; a few things are never fine. */
export function quickVerdict(req: PermissionRequest): Verdict | undefined {
  const cmd = req.command ?? "";
  const target = [cmd, ...req.paths].join(" ");
  // Danger first: reading a key is still reading a key.
  for (const [re, why] of DANGEROUS) if (re.test(cmd) || re.test(`cat ${target}`)) return { decision: "block", reason: why };
  if (LOOK.has(req.kind)) return { decision: "allow", reason: "only reads" };
  if (cmd && READ_ONLY_CMD.test(cmd)) return { decision: "allow", reason: "only reads" };
  return undefined;
}

const RULES = `You approve or block actions that coding agents want to take for a user, inside the repository at {root}. Decide for one action.

allow  reading, searching, building, testing, linting, formatting; creating and editing files in the repository; git status/diff/log/add/commit/branch/switch/stash; installing dependencies the project already declares; running the project's own scripts.
block  destroying data the task doesn't own (rm -rf outside the repository, git reset --hard or git clean -fdx on the user's checkout, deleting remote branches), force-pushing, reading or sending credentials and secrets, piping downloads into a shell, changing system configuration, anything unrelated to the goal.
ask    actions that publish or are hard to undo (git push, opening pull requests, deploying, publishing packages, database migrations against real data), network calls to unfamiliar hosts, installing new global tools — and anything you are unsure about.

Prefer ask over allow when in doubt. Reply with the decision and one short sentence of reason.`;

const VerdictSchema = z.object({ decision: z.enum(["allow", "block", "ask"]), reason: z.string() });

/** The model classifier: a small Claude model, no tools, one structured answer. Unsure on any failure. */
export function modelClassifier(cfg: Config): Classifier {
  return async (req, ctx) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      const q = query({
        prompt: `Goal of the run: ${ctx.goal?.slice(0, 2000) ?? "(not given)"}\n\nAction by ${req.agent}: ${req.kind}${req.command ? `\nCommand: ${req.command}` : ""}${req.title && req.title !== req.command ? `\nWhat it says it is: ${req.title}` : ""}${req.paths.length ? `\nPaths: ${req.paths.join(", ")}` : ""}`,
        options: {
          model: cfg.settings.auto_model,
          cwd: ctx.root,
          tools: [],
          maxTurns: 3,
          persistSession: false,
          settingSources: [],
          strictMcpConfig: true,
          abortController: abort,
          systemPrompt: RULES.replace("{root}", ctx.root),
          outputFormat: { type: "json_schema", schema: { type: "object", properties: { decision: { type: "string", enum: ["allow", "block", "ask"] }, reason: { type: "string" } }, required: ["decision", "reason"] } },
          pathToClaudeCodeExecutable: claudeExecutable(),
        },
      });
      for await (const m of q) {
        if (m.type === "result") {
          const v = VerdictSchema.safeParse(m.subtype === "success" ? m.structured_output : undefined);
          return v.success ? v.data : { decision: "ask", reason: "the classifier gave no clear answer" };
        }
      }
      return { decision: "ask", reason: "the classifier gave no answer" };
    } catch {
      return { decision: "ask", reason: "the classifier couldn't be reached" };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Who answers approval requests in a mode: full allows; auto classifies (asking the person only
 * when the classifier is unsure); ask asks the person. Without a person, an unsure answer is no.
 */
export function asker(
  mode: AccessMode,
  person: Asker | undefined,
  o: { classify: Classifier; root: string; goal?: string; remembered: Map<string, Verdict>; onVerdict?: (req: PermissionRequest, v: Verdict) => void },
): Asker | undefined {
  if (mode === "full") return async () => "once";
  if (mode === "ask") return person;
  return async (req): Promise<Answer> => {
    const key = `${req.kind}:${req.command ?? req.title}`;
    let v = o.remembered.get(key) ?? quickVerdict(req);
    if (!v) {
      v = await o.classify(req, { goal: o.goal, root: o.root });
      if (v.decision !== "ask") o.remembered.set(key, v);
    }
    o.onVerdict?.(req, v);
    if (v.decision === "allow") return "once";
    if (v.decision === "block") return "deny";
    return person ? person(req) : "deny";
  };
}
