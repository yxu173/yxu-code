/**
 * `yxu pr <task>`: push a task's branch and open a pull request that says what each agent did,
 * what was checked, what reviewers found, and which issue it closes.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readTaskRecord, taskAncestors } from "./combine.ts";
import { branchFor, git, tryGit } from "./git.ts";
import { gh } from "./github.ts";
import { addNote, readNotes, type IssueRef, type TaskNote } from "./task-notes.ts";
import type { TaskResult } from "./types.ts";

type Rec = TaskResult & { prompt?: string; parents?: string[]; baseRef?: string };

/** The task text the agent got, without yxu's preamble. */
export function taskText(rec: Rec): string {
  const p = rec.prompt ?? "";
  const i = p.lastIndexOf("\nTASK:\n");
  return (i >= 0 ? p.slice(i + 7) : p).trim();
}

const firstLine = (s: string, n = 100) => {
  const l = s.trim().split("\n")[0] ?? "";
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
};

const quote = (s: string, lines = 6) =>
  s
    .trim()
    .split("\n")
    .slice(0, lines)
    .map((l) => `> ${l}`)
    .join("\n");

/** Every task this one is made of (oldest first), plus itself. */
export function taskChain(root: string, taskId: string): Rec[] {
  return [...taskAncestors(root, taskId), taskId].map((id) => readTaskRecord(root, id) as Rec | undefined).filter((r): r is Rec => Boolean(r));
}

/** Read-only tasks (reviews) built on any task of the chain: what reviewers said. */
function reviewsOf(root: string, chain: Set<string>): TaskNote[] {
  const out: TaskNote[] = [];
  for (const id of chain) out.push(...readNotes(root, id).filter((n) => n.kind === "review"));
  return out;
}

export interface PrDraft {
  title: string;
  body: string;
  issue?: IssueRef;
  branch: string;
}

export function draftPr(root: string, taskId: string, opts: { title?: string } = {}): PrDraft {
  const head = readTaskRecord(root, taskId) as Rec | undefined;
  if (!head) throw new Error(`no task ${taskId} (see \`yxu show\` / the task ids a run printed)`);
  if (!head.branch && !tryGit(root, "rev-parse", "--verify", "--quiet", branchFor(taskId)).ok) throw new Error(`task ${taskId} has no changes to open a pull request with`);
  const chain = taskChain(root, taskId);
  const ids = new Set(chain.map((r) => r.taskId));
  const notes = chain.flatMap((r) => readNotes(root, r.taskId));
  const issue = notes.find((n): n is Extract<TaskNote, { kind: "issue" }> => n.kind === "issue")?.issue;

  const work = chain.filter((r) => r.agent !== "combine" && r.filesChanged.length);
  // The latest run in the chain: its goal names the PR, its report summarizes it.
  const run = [...notes].reverse().find((n): n is Extract<TaskNote, { kind: "run" }> => n.kind === "run");
  const title = opts.title ?? (issue ? issue.title : run ? firstLine(run.goal, 72) : firstLine(taskText(work.at(-1) ?? head), 72) || `Changes by yxu (${taskId})`);

  const lines: string[] = [];
  if (issue?.closes) lines.push(`Closes ${issue.closes}`, "");
  else if (issue) lines.push(`For ${issue.source} issue ${issue.id}${issue.url ? ` (${issue.url})` : ""}`, "");

  const files = [...new Set(chain.flatMap((r) => r.filesChanged))];
  const report = run?.report.trim() ? clipLines(run.report, 20) : "";
  lines.push("## Summary", report || firstParagraph(head.summary) || `Changes to ${files.length} file(s).`, "");

  lines.push("## What each agent did");
  for (const r of work) {
    lines.push(`- **${r.agent}**${r.model ? ` (${r.model})` : ""}: ${firstLine(taskText(r), 120)}`);
    lines.push(`  Files: ${r.filesChanged.map((f) => `\`${f}\``).join(", ")}`);
    if (r.summary.trim()) lines.push(quote(r.summary, 4).replace(/^/gm, "  "));
  }
  const merges = chain.filter((r) => r.agent === "combine");
  if (merges.length) lines.push(`- Combined ${merges.length} time(s) from parallel work${merges.some((m) => /resolved conflicts/.test(m.summary)) ? " (conflicts resolved by an agent)" : ""}.`);
  lines.push("");

  const verifies = notes.filter((n): n is Extract<TaskNote, { kind: "verify" }> => n.kind === "verify");
  lines.push("## Checks");
  if (!verifies.length) lines.push("- No checks were run by yxu.");
  else {
    // The latest result per command.
    const last = new Map<string, (typeof verifies)[number]>();
    for (const v of verifies) last.set(v.command, v);
    for (const v of last.values()) {
      lines.push(`- ${v.ok ? "✅" : "❌"} \`${v.command}\` ${v.ok ? "passed" : `failed (exit ${v.exitCode})`} in ${(v.durationMs / 1000).toFixed(0)}s`);
      if (!v.ok && v.tail.trim()) lines.push("  ```", ...v.tail.trim().split("\n").slice(-8).map((l) => `  ${l}`), "  ```");
    }
  }
  lines.push("");

  const reviews = reviewsOf(root, ids);
  if (reviews.length) {
    lines.push("## Review");
    for (const r of reviews) {
      if (r.kind !== "review") continue;
      const verdict = r.approved === undefined ? "" : r.approved ? " — approved" : " — not approved";
      lines.push(`- **${r.by}**${verdict}:`, quote(r.summary, 12).replace(/^/gm, "  "));
    }
    lines.push("");
  }

  lines.push("---", `Made with [yxu](https://github.com/yxu173/yxu-code): ${work.length} agent task(s), ${files.length} file(s). Task \`${taskId}\`.`);
  const slug = (issue ? `${issue.id.replace(/[^\w]+/g, "")}-${issue.title}` : title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return { title, body: lines.join("\n"), issue, branch: `yxu/${slug || "changes"}-${taskId.slice(-4)}` };
}

function clipLines(s: string, n: number): string {
  const lines = s.trim().split("\n");
  return lines.length > n ? `${lines.slice(0, n).join("\n")}\n…` : lines.join("\n");
}

function firstParagraph(s: string): string {
  return (s.trim().split(/\n\s*\n/)[0] ?? "").trim();
}

export interface OpenPrOptions {
  title?: string;
  base?: string;
  branch?: string;
  draft?: boolean;
  remote?: string;
}

/** Push the task's branch and open the pull request. Returns its URL. */
export function openPr(root: string, taskId: string, o: OpenPrOptions = {}, print: (l: string) => void = () => {}): string {
  const d = draftPr(root, taskId, { title: o.title });
  const remote = o.remote ?? "origin";
  const branch = o.branch ?? d.branch;
  const base = o.base ?? defaultBase(root, remote);
  const local = branchFor(taskId);
  const ahead = tryGit(root, "rev-list", "--count", `${remote}/${base}..${local}`);
  if (ahead.ok && ahead.out === "0") throw new Error(`task ${taskId} has nothing that ${remote}/${base} doesn't already have`);
  print(`pushing ${local} → ${remote}/${branch}`);
  git(root, "push", "--quiet", "-u", remote, `${local}:refs/heads/${branch}`);
  const url = gh(root, ["pr", "create", "--base", base, "--head", branch, "--title", d.title, "--body-file", "-", ...(o.draft ? ["--draft"] : [])], { stdin: d.body })
    .trim()
    .split("\n")
    .at(-1)!;
  return url;
}

/** The branch a PR goes into: the remote's default branch. */
export function defaultBase(root: string, remote = "origin"): string {
  const head = tryGit(root, "symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`).out;
  if (head) return head.replace(`refs/remotes/${remote}/`, "");
  try {
    return gh(root, ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]).trim() || "main";
  } catch {
    return "main";
  }
}

/** Record the run that made these tasks: the goal names a PR, the report summarizes it. */
export function tagRun(root: string, taskIds: Iterable<string>, run: { goal: string; report: string }) {
  for (const id of taskIds) addNote(root, id, { kind: "run", goal: run.goal, report: run.report });
}

/** Record that a run's tasks were for an issue (yxu pr links it). */
export function tagIssue(root: string, taskIds: Iterable<string>, issue: IssueRef) {
  for (const id of taskIds) addNote(root, id, { kind: "issue", issue: { source: issue.source, ref: issue.ref, id: issue.id, title: issue.title, url: issue.url, closes: issue.closes } });
}

/** Task ids with records, newest first (for completion and `yxu pr` without an id). */
export function recentTasks(root: string): string[] {
  try {
    return readdirSync(join(root, ".yxu", "runs")).sort().reverse();
  } catch {
    return [];
  }
}
