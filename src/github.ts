/**
 * GitHub through the `gh` CLI (its login, its host settings): issues in, pull requests out, CI logs.
 * Issues from other trackers come from plugins (Plugin.issues), as `<source>:<id>`.
 */
import { git, tryGit } from "./git.ts";
import { runSync, which } from "./platform.ts";
import type { IssueRef } from "./task-notes.ts";
import type { Config } from "./config.ts";
import { pluginContext } from "./plugins.ts";

export function gh(cwd: string, args: string[], opts: { stdin?: string } = {}): string {
  if (!which("gh")) throw new Error("this needs the GitHub CLI: install `gh` and run `gh auth login` (https://cli.github.com)");
  const p = opts.stdin === undefined ? runSync(["gh", ...args], { cwd }) : runStdin(cwd, ["gh", ...args], opts.stdin);
  if (p.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(p.stderr || p.stdout).trim().split("\n").slice(-3).join(" ")}`);
  return p.stdout;
}

function runStdin(cwd: string, argv: string[], stdin: string) {
  const p = Bun.spawnSync(argv, { cwd, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe", env: process.env });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

const ghJson = <T>(cwd: string, args: string[]): T => JSON.parse(gh(cwd, args)) as T;

// ── issues ───────────────────────────────────────────────────────────────

export interface Issue extends IssueRef {
  body: string;
  labels: string[];
  comments: { author: string; body: string }[];
}

/** 123, #123, owner/repo#123, or an issue URL → gh arguments. */
export function parseGithubIssue(ref: string): { number: string; repo?: string } | undefined {
  const url = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(ref);
  if (url) return { repo: url[1], number: url[2]! };
  const m = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/.exec(ref.trim());
  return m ? { repo: m[1], number: m[2]! } : undefined;
}

export function fetchGithubIssue(root: string, ref: string): Issue {
  const p = parseGithubIssue(ref);
  if (!p) throw new Error(`"${ref}" is not a GitHub issue (use 123, owner/repo#123 or a URL; other trackers: <source>:<id> from a plugin)`);
  const raw = ghJson<{ number: number; title: string; body: string; url: string; labels: { name: string }[]; comments: { author: { login: string }; body: string }[] }>(root, [
    "issue",
    "view",
    p.number,
    ...(p.repo ? ["--repo", p.repo] : []),
    "--json",
    "number,title,body,url,labels,comments",
  ]);
  const sameRepo = !p.repo || sameGithubRepo(root, p.repo);
  return {
    source: "github",
    ref,
    id: `#${raw.number}`,
    title: raw.title,
    url: raw.url,
    closes: sameRepo ? `#${raw.number}` : `${p.repo}#${raw.number}`,
    body: raw.body ?? "",
    labels: (raw.labels ?? []).map((l) => l.name),
    comments: (raw.comments ?? []).map((c) => ({ author: c.author?.login ?? "someone", body: c.body ?? "" })),
  };
}

function sameGithubRepo(root: string, repo: string): boolean {
  const url = tryGit(root, "remote", "get-url", "origin").out;
  return url.toLowerCase().replace(/\.git$/, "").endsWith(repo.toLowerCase());
}

/** Paths the issue mentions that exist in the repo (`src/a.ts`, src/a.ts:12, …). */
export function mentionedFiles(root: string, text: string): string[] {
  const tracked = new Set(tryGit(root, "ls-files").out.split("\n").filter(Boolean));
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s`'"(\[])((?:\.\/)?[\w@.-]+(?:\/[\w@.-]+)+|[\w-]+\.[a-z]{1,5})(?::\d+(?:-\d+)?)?(?=$|[\s`'"),.:;\]])/gm)) {
    const path = m[1]!.replace(/^\.\//, "");
    if (tracked.has(path)) found.add(path);
  }
  return [...found].slice(0, 20);
}

const MAX_ISSUE_CHARS = 20_000;

/** The goal for a run that works on an issue. */
export function issueGoal(root: string, issue: Issue, extra?: string): string {
  const parts = [`Resolve ${issue.source === "github" ? "GitHub issue" : `${issue.source} issue`} ${issue.id}${issue.url ? ` (${issue.url})` : ""}: ${issue.title}`];
  if (issue.labels.length) parts.push(`Labels: ${issue.labels.join(", ")}`);
  if (issue.body.trim()) parts.push(issue.body.trim());
  if (issue.comments.length) parts.push(`Comments:\n${issue.comments.map((c) => `- @${c.author}: ${c.body.trim()}`).join("\n")}`);
  const files = mentionedFiles(root, [issue.body, ...issue.comments.map((c) => c.body)].join("\n"));
  if (files.length) parts.push(`Files mentioned in the issue: ${files.join(", ")}`);
  if (extra?.trim()) parts.push(`Also: ${extra.trim()}`);
  parts.push("When you report, say which parts of the issue are resolved and which are not.");
  const text = parts.join("\n\n");
  return text.length > MAX_ISSUE_CHARS ? `${text.slice(0, MAX_ISSUE_CHARS)}\n… (issue text cut at ${MAX_ISSUE_CHARS} characters)` : text;
}

// ── pull requests ────────────────────────────────────────────────────────

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  maintainerCanModify?: boolean;
  checks: Check[];
}

export interface Check {
  name: string;
  state: "pass" | "fail" | "pending" | "skipped";
  url?: string;
  /** GitHub Actions run id, when the check is an Actions job. */
  runId?: string;
}

interface RollupItem {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  workflowName?: string;
}

export function checkState(c: RollupItem): Check["state"] {
  const v = (c.conclusion || c.state || "").toUpperCase();
  if (["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(v)) return "fail";
  if (["SUCCESS", "NEUTRAL"].includes(v)) return "pass";
  if (v === "SKIPPED") return "skipped";
  return "pending";
}

export function viewPr(root: string, pr: string): PrInfo {
  const raw = ghJson<Omit<PrInfo, "checks"> & { statusCheckRollup: RollupItem[] }>(root, [
    "pr",
    "view",
    pr,
    "--json",
    "number,url,title,headRefName,baseRefName,isCrossRepository,maintainerCanModify,statusCheckRollup",
  ]);
  const checks = (raw.statusCheckRollup ?? []).map((c): Check => {
    const url = c.detailsUrl ?? c.targetUrl;
    return { name: [c.workflowName, c.name ?? c.context].filter(Boolean).join(" / "), state: checkState(c), url, runId: url ? /\/actions\/runs\/(\d+)/.exec(url)?.[1] : undefined };
  });
  const { statusCheckRollup: _, ...rest } = raw;
  return { ...rest, checks };
}

const LOG_LINES_PER_JOB = 150;
const MAX_LOG_CHARS = 25_000;

/** The failing part of the CI logs: the last lines of each failed Actions job. */
export function failedLogs(root: string, checks: Check[]): string {
  const runs = [...new Set(checks.filter((c) => c.state === "fail" && c.runId).map((c) => c.runId!))];
  const parts: string[] = [];
  for (const id of runs) {
    let log: string;
    try {
      log = gh(root, ["run", "view", id, "--log-failed"]);
    } catch (e) {
      parts.push(`(could not read the logs of run ${id}: ${(e as Error).message})`);
      continue;
    }
    // Lines look like "<job>\t<step>\t<timestamp> <text>"; keep the end of each job.
    const byJob = new Map<string, string[]>();
    for (const line of log.split("\n")) {
      const [job, step, ...rest] = line.split("\t");
      if (!job || rest.length === 0) continue;
      // Drop the timestamp (the first line starts with a byte-order mark) and terminal colors.
      const text = rest
        .join("\t")
        .replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")
        .replace(/(?:\x1b|\^\[)\[[0-9;]*m/g, "");
      const key = `${job} › ${step}`;
      byJob.set(key, [...(byJob.get(key) ?? []), text]);
    }
    for (const [key, lines] of byJob) parts.push(`### ${key}\n${lines.slice(-LOG_LINES_PER_JOB).join("\n")}`);
  }
  const text = parts.join("\n\n");
  return text.length > MAX_LOG_CHARS ? `… (earlier log lines cut)\n${text.slice(-MAX_LOG_CHARS)}` : text;
}

/** Fetch a PR's head into a local ref yxu can start a task from. */
export function fetchPrHead(root: string, pr: PrInfo): string {
  const ref = `refs/yxu/pr/${pr.number}`;
  git(root, "fetch", "--quiet", "origin", `+refs/pull/${pr.number}/head:${ref}`);
  return ref;
}

/** An issue from GitHub, or from a plugin's tracker for `<source>:<id>` refs. */
export async function resolveIssue(root: string, cfg: Config, ref: string): Promise<Issue> {
  const m = /^([a-z][a-z0-9-]*):(.+)$/.exec(ref);
  if (m && !/^https?$/.test(m[1]!)) {
    const found = cfg.plugins?.issues.get(m[1]!);
    if (!found) throw new Error(`no issue source "${m[1]}" (plugins add them, e.g. linear or jira; see \`yxu plugins\`)`);
    const x = await found.source.fetch(m[2]!, pluginContext(found.plugin, root, cfg as unknown as Record<string, unknown>));
    if (!x || typeof x.title !== "string") throw new Error(`issue source ${m[1]} (plugin ${found.plugin}) returned no issue for ${m[2]}`);
    return { source: m[1]!, ref, id: x.id ?? m[2]!, title: x.title, url: x.url, body: x.body ?? "", labels: x.labels ?? [], comments: x.comments ?? [] };
  }
  return fetchGithubIssue(root, ref);
}
