/**
 * `yxu agent test <name>` runs a tiny task with an agent in a scratch repo and shows what yxu
 * understood: events, summary, files, diff, tokens and cost, and whether the task was really
 * done. `yxu agent capture <name>` does the same and saves the raw output (for bug reports and
 * adapter fixtures).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { toProfile, type Config } from "./config.ts";
import { git, YXU_IDENTITY } from "./git.ts";
import type { Asker } from "./permissions.ts";
import { runDir, runTask } from "./runner.ts";
import { guard, untrustedYolo } from "./trust.ts";
import type { AgentEvent } from "./types.ts";

export const CHECK_FILE = "yxu-check.txt";
export const DEFAULT_TASK = `Create a file named ${CHECK_FILE} in the current directory whose only content is the word: ready
Do not change anything else. Then reply with one short sentence saying what you did.`;

export interface AgentTestOptions {
  task?: string;
  keep?: boolean;
  /** Save raw output here (capture). */
  captureDir?: string;
  ask?: Asker;
  print: (line: string) => void;
  dim: (s: string) => string;
}

export async function agentTest(cfg: Config, name: string, o: AgentTestOptions): Promise<boolean> {
  const def = cfg.agents[name];
  if (!def) throw new Error(`unknown agent "${name}" (have: ${Object.keys(cfg.agents).join(", ")})`);
  if (def.command) guard(cfg, `agents.${name}.command`, `agent ${name}'s command \`${def.command.join(" ")}\``);
  const profile = toProfile(def);
  if (untrustedYolo(cfg, name)) profile.permission = "accept-edits";

  const scratch = mkdtempSync(join(tmpdir(), `yxu-agent-test-${name}-`));
  git(scratch, "init", "-q", "-b", "main");
  writeFileSync(join(scratch, "README.md"), "# scratch repo for `yxu agent test`\n");
  git(scratch, "add", ".");
  git(scratch, ...YXU_IDENTITY, "commit", "-qm", "init");

  const { print, dim } = o;
  const task = o.task ?? DEFAULT_TASK;
  print(`agent    ${name} · ${def.cli}${def.model ? ` · ${def.model}` : ""} · permission ${profile.permission}${profile.sandbox === "bwrap" ? " · sandboxed" : ""}`);
  print(`repo     ${scratch} ${dim("(scratch)")}`);
  print(`task     ${task.split("\n")[0]}`);
  print("");
  const events: AgentEvent[] = [];
  const r = await runTask({
    agentName: name,
    profile,
    prompt: task,
    title: "agent test",
    cwd: scratch,
    ask: o.ask,
    onStart: (_id, argv) => print(dim(`$ ${argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ").slice(0, 300)}`)),
    onEvent: (_id, e) => {
      events.push(e);
      if (e.kind === "tool") print(dim(`  ${e.status === "failed" ? "✗" : e.status === "completed" ? "✓" : "·"} ${e.name}${e.target ? ` ${e.target}` : ""}`));
      if (e.kind === "permission") print(`  △ ${e.tool} — ${e.decision}`);
      if (e.kind === "error") print(`  ! ${e.message}`);
    },
  });

  const logs = runDir(scratch, r.taskId);
  const stored = existsSync(join(logs, "events.json")) ? (JSON.parse(readFileSync(join(logs, "events.json"), "utf8")) as AgentEvent[]) : events;
  const content = r.branch ? git(scratch, "show", `${r.branch}:${CHECK_FILE}`) : "";
  const did = !o.task ? content.trim() === "ready" : r.filesChanged.length > 0;

  print("");
  print(`exit       ${r.exitCode ?? "(killed)"} · ${(r.durationMs / 1000).toFixed(1)}s`);
  print(`success    ${r.ok ? "yes" : `no — ${r.error ?? "unknown error"}`} ${dim("(as yxu read it)")}`);
  print(`summary    ${r.summary ? r.summary.split("\n").join("\n           ") : dim("(empty)")}`);
  print(`events     ${stored.length} ${dim(summarizeEvents(stored))}`);
  print(`files      ${r.filesChanged.join(", ") || dim("(none)")}`);
  if (r.diff) print(dim(r.diff.split("\n").slice(0, 20).map((l) => `           ${l}`).join("\n")));
  const tokens = r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens;
  print(`usage      ${tokens ? `${r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens} in / ${r.usage.outputTokens} out` : dim("not reported")}${r.costUsd !== undefined ? ` · $${r.costUsd.toFixed(4)}` : ""}`);
  print("");

  const problems: string[] = [];
  if (!did) problems.push(o.task ? "the agent changed no files" : `${CHECK_FILE} with "ready" was not created in the agent's worktree`);
  if (did && !r.ok) problems.push("the work was done, but yxu read the run as failed: check `success` (generic agents) or the agent's exit code");
  if (r.ok && !r.summary) problems.push("no summary was found: for generic agents set `summary:` (see the captured stdout)");
  if (r.summary.includes("wrote outside its worktree")) problems.push("the agent wrote outside its worktree: pass {{cwd}} to the CLI, or use sandbox: bwrap");
  const pass = did && r.ok && problems.length === 0;
  print(pass ? `PASS  ${name} works with yxu` : `FAIL  ${name}\n${problems.map((p) => `  - ${p}`).join("\n")}`);

  if (o.captureDir) {
    const out = resolve(o.captureDir);
    mkdirSync(out, { recursive: true });
    cpSync(logs, out, { recursive: true });
    writeFileSync(join(out, "agent.json"), `${JSON.stringify({ name, ...def, task, pass, problems }, null, 2)}\n`);
    print(dim(`captured stdout.log, stderr.log, events.json and result.json in ${out}`));
  }
  if (pass && !o.keep) rmSync(scratch, { recursive: true, force: true });
  else print(dim(`scratch repo kept: ${scratch} (logs in ${logs})`));
  return pass;
}

function summarizeEvents(events: AgentEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    const k = e.kind === "tool" ? `tool:${e.name}` : e.kind;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k}×${n}`).join(" ");
}
