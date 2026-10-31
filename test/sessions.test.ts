import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { Conversation } from "../src/conversation.ts";
import { branchFor, git, YXU_IDENTITY } from "../src/git.ts";
import { Session } from "../src/ops.ts";
import type { RunOutcome } from "../src/orchestrator/run.ts";
import { writeTaskRecord } from "../src/runner.ts";
import { canonPath, deleteSession, findSession, listSessions, newSession, renameSession, restoreTasks, saveSession, sessionsDir, type SessionFile } from "../src/sessions.ts";
import { App, type Engine } from "../src/tui/app.ts";
import { createTheme } from "../src/tui/theme.ts";
import type { Frame } from "../src/tui/view.ts";
import { emptyUsage } from "../src/types.ts";
import { testCatalog } from "./helpers.ts";

let data: string;
let repoA: string;
let repoB: string;

const repo = () => {
  const r = mkdtempSync(join(tmpdir(), "yxu-sess-repo-"));
  git(r, "init", "-q", "-b", "main");
  writeFileSync(join(r, "README"), "x\n");
  git(r, "add", ".");
  git(r, ...YXU_IDENTITY, "commit", "-qm", "init");
  return r;
};

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "yxu-sess-data-"));
  process.env.YXU_DATA_DIR = data;
  repoA = repo();
  repoB = repo();
});
afterEach(() => {
  delete process.env.YXU_DATA_DIR;
  for (const d of [data, repoA, repoB]) rmSync(d, { recursive: true, force: true });
});

function made(root: string, folder: string, title: string, turns = 1): SessionFile {
  const c = new Conversation();
  for (let i = 0; i < turns; i++) c.finish({ goal: `${title} ${i}`, finalText: `answer ${i}`, sessionId: `claude-${title}`, usedSummary: false });
  const s = newSession(root, folder, c.state);
  s.title = title;
  saveSession(s);
  return s;
}

describe("the session store", () => {
  test("saved per user, listed by repository or folder, newest first; found by id, prefix or last", async () => {
    expect(sessionsDir()).toBe(join(data, "sessions"));
    const a1 = made(repoA, repoA, "fix login");
    await Bun.sleep(5);
    mkdirSync(join(repoA, "web"));
    const a2 = made(repoA, join(repoA, "web"), "web styles");
    await Bun.sleep(5);
    const b1 = made(repoB, repoB, "other repo");
    expect(listSessions().map((s) => s.title)).toEqual(["other repo", "web styles", "fix login"]);
    expect(listSessions({ root: repoA }).map((s) => s.title)).toEqual(["web styles", "fix login"]);
    expect(listSessions({ root: repoA, folder: join(repoA, "web") }).map((s) => s.title)).toEqual(["web styles"]);
    expect(findSession("last", repoA).id).toBe(a2.id);
    expect(findSession(a1.id).title).toBe("fix login");
    expect(findSession(b1.id.slice(0, 11)).id).toBe(b1.id);
    expect(() => findSession("zzz")).toThrow(/no session "zzz"/);
    renameSession(a1.id, "Fix the login form\nsecond line");
    expect(findSession(a1.id).title).toBe("Fix the login form");
    deleteSession(a1.id);
    expect(listSessions({ root: repoA })).toHaveLength(1);
    // A session where nothing happened isn't kept.
    saveSession(newSession(repoA, repoA, new Conversation().state));
    expect(listSessions({ root: repoA })).toHaveLength(1);
  });

  test("the same folder matches however its path is spelled (symlinks, as on macOS)", () => {
    if (process.platform === "win32") return;
    const link = `${repoA}-link`;
    symlinkSync(repoA, link);
    made(link, link, "via link");
    expect(listSessions({ root: repoA }).map((s) => s.title)).toEqual(["via link"]);
    expect(listSessions({ root: `${link}/` }).map((s) => s.title)).toEqual(["via link"]);
    expect(canonPath("C:\\x\\y")).toBe("C:/x/y");
    rmSync(link);
  });

  test("tasks come back pending only while their branch exists", () => {
    const s = made(repoA, repoA, "t");
    for (const id of ["t-live", "t-gone"]) {
      writeTaskRecord(repoA, { taskId: id, agent: "coder", ok: true, summary: "s", usage: emptyUsage(), exitCode: 0, durationMs: 1, diff: "d", filesChanged: ["a"], branch: branchFor(id) }, { prompt: "p" });
      s.tasks.push(id);
    }
    git(repoA, "branch", branchFor("t-live"));
    const into = new Session();
    restoreTasks(s, into);
    expect(into.pending().map((t) => t.taskId)).toEqual(["t-live"]);
    expect(into.tasks.get("t-gone")!.discarded).toBe(true);
  });
});

function app(root: string, engine: Engine, resume?: SessionFile) {
  return app_(root, engine, resume);
}

function app_(root: string, engine: Engine, resume?: SessionFile) {
  let frame: Frame = { rows: [] };
  const a = new App({
    cfg: parseConfig("agents:\n  coder: { cli: opencode }\ncontext: { repo_map: false }\nsettings: { apply: ask }\n", join(root, "yxu.yaml")),
    root,
    resume,
    theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
    engine,
    historyFile: null,
    catalog: testCatalog(),
    draw: (f) => (frame = f),
    size: () => ({ width: 140, height: 50 }),
    exit: () => {},
  });
  const screen = () => {
    a.render();
    return frame.rows.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  };
  return { app: a, screen };
}

describe("sessions in the interface", () => {
  const runs: { goal: string; resume?: string }[] = [];
  const engine: Engine = {
    async run({ goal, resume, session }) {
      runs.push({ goal, resume });
      return { runId: "r", ok: true, finalText: `did: ${goal}`, costUsd: 0.01, session, sdkSessionId: resume ?? `claude-${runs.length}` } as RunOutcome;
    },
  };

  test("each turn saves the session; resuming brings back the conversation; /sessions, /resume, /rename, /new", async () => {
    runs.length = 0;
    const first = app(repoA, engine);
    first.app.input("Add a login form\r");
    await first.app.idle();
    first.app.input("Now validate the email\r");
    await first.app.idle();
    let [saved] = listSessions({ root: repoA });
    expect(saved).toMatchObject({ title: "Add a login form", root: canonPath(repoA), folder: canonPath(repoA), costUsd: 0.02, workflow: "default" });
    expect(saved!.conversation).toMatchObject({ turn: 2, sessionId: "claude-1" });
    first.app.input("/rename Login work\r");
    expect(findSession(saved!.id).title).toBe("Login work");
    first.app.input("/new\r");
    first.app.input("Something else\r");
    await first.app.idle();
    expect(listSessions({ root: repoA })).toHaveLength(2);
    first.app.dispose();

    // Later, a new interface on the first session.
    saved = findSession(saved!.id);
    const second = app(repoA, engine, saved);
    let s = second.screen();
    expect(s).toContain("resumed · Login work");
    expect(s).toContain("Now validate the email");
    expect(s).toContain("did: Now validate the email");
    second.app.input("And add a test\r");
    await second.app.idle();
    expect(runs.at(-1)).toEqual({ goal: "And add a test", resume: "claude-1" }); // the same Claude conversation
    expect(findSession(saved.id).conversation.turn).toBe(3);

    second.app.input("/sessions\r");
    s = second.screen();
    expect(s).toContain("▸ " + saved.id);
    expect(s).toContain("Something else");
    second.app.input("/sessions all\r");
    expect(second.screen()).toContain("(all repositories)");

    // /resume switches to another session of this repo; one of another repo says how.
    const other = listSessions({ root: repoA }).find((x) => x.id !== saved!.id)!;
    second.app.input(`/resume ${other.id.slice(0, 10)}\r`);
    expect(second.screen()).toContain("resumed · Something else");
    second.app.input("one more\r");
    await second.app.idle();
    expect(runs.at(-1)!.resume).toBe(other.conversation.sessionId);
    const elsewhere = made(repoB, repoB, "elsewhere");
    second.app.input(`/resume ${elsewhere.id}\r`);
    expect(second.screen()).toContain(`yxu resume ${elsewhere.id}`);
    second.app.dispose();
  });
});

describe("/new", () => {
  test("opens an empty chat; the old one is saved and offered back with its waiting results", async () => {
    const engine: Engine = {
      async run({ goal, session }) {
        const t = { taskId: "t-new-1", agent: "coder", ok: true, summary: "s", usage: emptyUsage(), exitCode: 0, durationMs: 1, diff: "+x", filesChanged: ["a"], branch: branchFor("t-new-1") };
        writeTaskRecord(repoA, t, { prompt: "p" });
        git(repoA, "branch", branchFor("t-new-1"));
        session.tasks.set("t-new-1", { ...t, prompt: "p", parents: [] });
        return { runId: "r", ok: true, finalText: `did: ${goal}`, costUsd: 0.2, session, sdkSessionId: "c-1" } as RunOutcome;
      },
    };
    const { app, screen } = app_(repoA, engine);
    app.input("Build the export\r");
    await app.idle();
    expect(app.store.state.status).toBe("deciding");
    const old = listSessions({ root: repoA })[0]!;

    app.input("/new\r");
    const st = app.store.state;
    expect(st.entries).toEqual([]);
    expect(st).toMatchObject({ turn: 0, tasks: [], status: "ready", decision: undefined, remembering: false, cost: { orchestrator: 0, subagents: 0 } });
    const s = screen();
    expect(s).toContain("What should we work on?");
    expect(s).toContain(`/resume ${old.id}`);
    expect(s).toContain("Build the export · just now · 1 to apply");
    expect(s).not.toContain("did: Build the export");
    app.dispose();
  });

  test("waits for a running turn", async () => {
    let release!: () => void;
    const engine: Engine = { run: ({ session }) => new Promise((r) => (release = () => r({ runId: "r", ok: true, finalText: "ok", costUsd: 0, session } as RunOutcome))) };
    const { app } = app_(repoA, engine);
    app.input("go\r");
    await Bun.sleep(5);
    app.input("/new\r");
    expect(app.store.state.flash).toContain("esc cancels it, then /new");
    expect(app.store.state.entries.length).toBeGreaterThan(0);
    release();
    await app.idle();
    app.dispose();
  });
});

describe("yxu sessions", () => {
  const cli = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { cwd, env: { ...process.env, YXU_DATA_DIR: data }, stdout: "pipe", stderr: "pipe" });
    return p.stdout.toString() + p.stderr.toString();
  };

  test("lists this repo's sessions, every repo's grouped, and as JSON; rm and rename", () => {
    const a = made(repoA, repoA, "fix login", 2);
    made(repoB, repoB, "other repo");
    let out = cli(repoA, "sessions");
    expect(out).toContain(`${a.id}  fix login  ·  2 turns · just now`);
    expect(out).not.toContain("other repo");
    out = cli(repoA, "sessions", "--all");
    expect(out).toContain("fix login");
    expect(out).toContain("other repo");
    expect(out).toContain(canonPath(repoB).split("/").at(-1)!);
    expect(JSON.parse(cli(repoA, "sessions", "--json"))[0]).toMatchObject({ id: a.id, title: "fix login", turns: 2 });
    // Outside any repository: every repository's.
    expect(cli(tmpdir(), "sessions")).toContain("other repo");
    expect(cli(repoA, "sessions", "rename", a.id.slice(0, 10), "Login form")).toContain("renamed");
    expect(findSession(a.id).title).toBe("Login form");
    expect(cli(repoA, "sessions", "rm", a.id.slice(0, 10))).toContain("deleted session");
    expect(listSessions({ root: repoA })).toEqual([]);
  }, 30_000);
});
