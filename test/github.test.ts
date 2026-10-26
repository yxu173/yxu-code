import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { fixCi } from "../src/fix-ci.ts";
import { checkState, fetchGithubIssue, issueGoal, mentionedFiles, parseGithubIssue } from "../src/github.ts";
import { branchFor, git, YXU_IDENTITY } from "../src/git.ts";
import { Session, TaskOps } from "../src/ops.ts";
import { draftPr, openPr, tagIssue, tagRun } from "../src/pr.ts";
import { readNotes } from "../src/task-notes.ts";
import { fakeCli, pathWith } from "./helpers.ts";

let root: string;
let remote: string;
let bin: string;
let fix: string;
const origPath = process.env.PATH;

// Fake `opencode`: writes files for every "WRITE <file> <word>" in the prompt.
const FAKE_AGENT = `#!/bin/sh
for a; do last="$a"; done
printf '%s\\n' "$last" | grep -oE 'WRITE [^ ]+ [^ ]+' | while read _ f c; do printf '%s\\n' "$c" > "$f"; done
echo '{"type":"text","sessionID":"s","part":{"type":"text","text":"done: found the cause"}}'
echo '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{"input":1,"output":1},"cost":0}}'
`;

// Fake `gh`: answers from files in $GH_FIX, keeps the PR body it was given.
const FAKE_GH = `#!/bin/sh
echo "$@" >> "$GH_FIX/calls"
case "$1 $2" in
  "issue view") cat "$GH_FIX/issue.json" ;;
  "pr view") cat "$GH_FIX/pr.json" ;;
  "pr create") cat > "$GH_FIX/body.md"; echo "https://github.com/acme/app/pull/9" ;;
  "run view") cat "$GH_FIX/log.txt" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;

const CONFIG = `agents:
  coder: { cli: opencode }
  debugger: { cli: opencode, instructions: "Role: debugger." }
  reviewer: { cli: opencode, permission: plan }
settings:
  verify: test -f fixed.txt || test -f a.txt
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-gh-"));
  remote = mkdtempSync(join(tmpdir(), "yxu-gh-remote-"));
  bin = mkdtempSync(join(tmpdir(), "yxu-gh-bin-"));
  fix = mkdtempSync(join(tmpdir(), "yxu-gh-fix-"));
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "x\n");
  writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "origin", "main");
  git(root, "remote", "set-head", "origin", "main");
  fakeCli(bin, "opencode", FAKE_AGENT);
  fakeCli(bin, "gh", FAKE_GH);
  process.env.PATH = pathWith(bin, origPath);
  process.env.GH_FIX = fix;
});

afterEach(() => {
  process.env.PATH = origPath;
  delete process.env.GH_FIX;
  for (const d of [root, remote, bin, fix]) rmSync(d, { recursive: true, force: true });
});

const cfg = () => parseConfig(CONFIG, join(root, "yxu.yaml"));

describe("issues", () => {
  test("refs, check states and mentioned files", () => {
    expect(parseGithubIssue("123")).toEqual({ number: "123", repo: undefined });
    expect(parseGithubIssue("#5")).toEqual({ number: "5", repo: undefined });
    expect(parseGithubIssue("acme/app#7")).toEqual({ number: "7", repo: "acme/app" });
    expect(parseGithubIssue("https://github.com/acme/app/issues/8")).toEqual({ number: "8", repo: "acme/app" });
    expect(parseGithubIssue("linear:ENG-1")).toBeUndefined();
    expect(checkState({ conclusion: "FAILURE" })).toBe("fail");
    expect(checkState({ conclusion: "SUCCESS" })).toBe("pass");
    expect(checkState({ status: "IN_PROGRESS" })).toBe("pending");
    expect(checkState({ state: "ERROR" })).toBe("fail");
    expect(mentionedFiles(root, "crash in `app.ts:3` and README.md, not in src/missing.ts")).toEqual(["app.ts", "README.md"]);
  });

  test("a GitHub issue becomes the goal: title, body, comments, files", () => {
    writeFileSync(
      join(fix, "issue.json"),
      JSON.stringify({ number: 7, title: "Crash on empty input", body: "Steps: call `a` in app.ts with ''.", url: "https://github.com/acme/app/issues/7", labels: [{ name: "bug" }], comments: [{ author: { login: "sam" }, body: "Also see README.md" }] }),
    );
    const issue = fetchGithubIssue(root, "7");
    expect(issue).toMatchObject({ source: "github", id: "#7", closes: "#7", labels: ["bug"] });
    const goal = issueGoal(root, issue, "keep it small");
    expect(goal).toContain("Resolve GitHub issue #7 (https://github.com/acme/app/issues/7): Crash on empty input");
    expect(goal).toContain("Labels: bug");
    expect(goal).toContain("- @sam: Also see README.md");
    expect(goal).toContain("Files mentioned in the issue: app.ts, README.md");
    expect(goal).toContain("Also: keep it small");
  });
});

describe("yxu pr", () => {
  test("pushes the task's branch and opens a PR that says what agents did, checks, reviews and the issue", async () => {
    const c = cfg();
    const ops = new TaskOps(c, root, new Session(), {});
    const t = await ops.delegate("coder", "Fix the crash: WRITE a.txt hello");
    expect(t.branch).toBeDefined();
    await ops.verify(t.taskId);
    await ops.delegate("reviewer", "Review the change", t.taskId);
    tagIssue(root, [t.taskId], { source: "github", ref: "7", id: "#7", title: "Crash on empty input", url: "https://github.com/acme/app/issues/7", closes: "#7" });
    expect(readNotes(root, t.taskId).map((n) => n.kind)).toEqual(["verify", "review", "issue"]);

    const d = draftPr(root, t.taskId);
    expect(d.title).toBe("Crash on empty input");
    expect(d.branch).toMatch(/^yxu\/7-crash-on-empty-input-\w{4}$/);
    expect(d.body).toStartWith("Closes #7\n");
    expect(d.body).toContain("- **coder**: Fix the crash: WRITE a.txt hello\n  Files: `a.txt`");
    expect(d.body).toContain("✅ `test -f fixed.txt || test -f a.txt` passed");
    expect(d.body).toContain("- **reviewer**:\n  > done: found the cause");

    const url = openPr(root, t.taskId, { draft: true });
    expect(url).toBe("https://github.com/acme/app/pull/9");
    expect(git(remote, "rev-parse", `refs/heads/${d.branch}`)).toBe(git(root, "rev-parse", branchFor(t.taskId)));
    expect(readFileSync(join(fix, "calls"), "utf8")).toContain(`pr create --base main --head ${d.branch} --title Crash on empty input --body-file - --draft`);
    expect(readFileSync(join(fix, "body.md"), "utf8")).toBe(d.body);
  }, 30_000);

  test("without an issue, the run's goal is the title and its report the summary", async () => {
    const ops = new TaskOps(cfg(), root, new Session(), {});
    const t = await ops.delegate("coder", "In this repo (ES modules…): WRITE a.txt hello");
    tagRun(root, [t.taskId], { goal: "Add a greeting file\nwith more detail", report: "Added a.txt with a greeting.\n\n- a.txt: new" });
    const d = draftPr(root, t.taskId);
    expect(d.title).toBe("Add a greeting file");
    expect(d.body).toStartWith("## Summary\nAdded a.txt with a greeting.\n\n- a.txt: new\n");
    expect(d.body).toContain("No checks were run by yxu.");
  }, 30_000);

  test("refuses a task without changes", async () => {
    const ops = new TaskOps(cfg(), root, new Session(), {});
    const t = await ops.delegate("coder", "nothing to write");
    expect(() => draftPr(root, t.taskId)).toThrow(/no changes/);
    expect(() => draftPr(root, "nope")).toThrow(/no task nope/);
  }, 30_000);
});

describe("yxu fix-ci", () => {
  const pr = (conclusion: string, cross = false) =>
    writeFileSync(
      join(fix, "pr.json"),
      JSON.stringify({
        number: 5,
        url: "https://github.com/acme/app/pull/5",
        title: "Add feature",
        headRefName: "feature",
        baseRefName: "main",
        isCrossRepository: cross,
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", workflowName: "ci", status: "COMPLETED", conclusion, detailsUrl: "https://github.com/acme/app/actions/runs/99/job/1" },
          { __typename: "CheckRun", name: "lint", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/app/actions/runs/99/job/2" },
        ],
      }),
    );
  const pushFeature = () => {
    git(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "feature.ts"), "export const f = 1;\n");
    git(root, "add", ".");
    git(root, ...YXU_IDENTITY, "commit", "-qm", "feature");
    git(root, "push", "-q", "origin", "feature", "feature:refs/pull/5/head");
    git(root, "checkout", "-q", "main");
  };

  test("reads the failed logs, fixes on the PR's head, verifies, and pushes", async () => {
    pushFeature();
    pr("FAILURE");
    writeFileSync(join(fix, "log.txt"), "test\tRun tests\t\uFEFF2026-10-26T10:00:00.0000000Z \x1b[36;1mexpected fixed.txt to exist\x1b[0m\ntest\tRun tests\t2026-10-26T10:00:01.0000000Z hint: WRITE fixed.txt ok\n");
    const lines: string[] = [];
    let asked = "";
    const r = await fixCi(root, cfg(), "5", { print: (l) => lines.push(l), confirmPush: async (m) => ((asked = m), true) });
    expect(r).toMatchObject({ status: "fixed", pushed: true });
    expect(lines[0]).toBe("#5 Add feature: 1 failing check(s): ci / test");
    expect(asked).toBe("push 1 commit(s) fixing CI to origin/feature (#5)?");
    // The fix sits on top of the PR's head, on the PR's branch.
    expect(git(remote, "show", "feature:fixed.txt")).toBe("ok");
    expect(git(remote, "show", "feature:feature.ts")).toBe("export const f = 1;");
    expect(git(remote, "log", "-1", "--format=%s", "feature")).toBe("yxu(debugger): Fix CI: ci / test");
    // The agent got the log tail and its role.
    const rec = JSON.parse(readFileSync(join(root, ".yxu", "runs", r.taskId!, "result.json"), "utf8"));
    expect(rec.prompt).toContain("Role: debugger.");
    expect(rec.prompt).toContain("### test › Run tests\nexpected fixed.txt to exist");
    expect(readFileSync(join(fix, "calls"), "utf8")).toContain("run view 99 --log-failed");
  }, 30_000);

  test("passing, pending, declined push, and forks", async () => {
    pushFeature();
    pr("SUCCESS");
    expect(await fixCi(root, cfg(), "5", { print: () => {} })).toMatchObject({ status: "passing" });
    pr("");
    expect((await fixCi(root, cfg(), "5", { print: () => {} })).message).toContain("still running");

    pr("FAILURE");
    writeFileSync(join(fix, "log.txt"), "test\tRun\t2026-10-26T10:00:00Z WRITE fixed.txt ok\n");
    const declined = await fixCi(root, cfg(), "5", { print: () => {}, confirmPush: async () => false });
    expect(declined).toMatchObject({ status: "fixed", pushed: false });
    expect(declined.message).toContain(`git push origin ${branchFor(declined.taskId!)}:feature`);
    expect(() => git(remote, "show", "feature:fixed.txt")).toThrow();

    pr("FAILURE", true);
    const fork = await fixCi(root, cfg(), "5", { print: () => {}, confirmPush: async () => true });
    expect(fork).toMatchObject({ status: "fixed", pushed: false });
    expect(fork.message).toContain("comes from a fork");
  }, 60_000);
});
