import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, YXU_IDENTITY } from "../src/git.ts";
import { liveTask, liveTasks, onLiveChange, runTask } from "../src/runner.ts";
import type { AgentEvent, AgentProfile } from "../src/types.ts";
import { fakeCli, pathWith, testCatalog } from "./helpers.ts";
import { parseConfig } from "../src/config.ts";
import { Session, TaskOps } from "../src/ops.ts";
import type { RunOutcome } from "../src/orchestrator/run.ts";
import { App, type Engine } from "../src/tui/app.ts";
import { createTheme } from "../src/tui/theme.ts";
import type { Frame } from "../src/tui/view.ts";

let root: string;
let bin: string;
const origPath = process.env.PATH;

// Fake `opencode`: streams a session and a tool call, writes a.txt, works for $FAKE_SLEEP seconds.
// Resumed (--session S1): writes b.txt with the message it got, and finishes at once.
const FAKE = `#!/bin/sh
printf '%s\n' "$*" | tr '\n' ' ' >> "$FAKE_LOG"; echo >> "$FAKE_LOG"
for a; do last="$a"; done
case "$*" in *"--session S1"*)
  printf '%s\\n' "$last" > b.txt
  echo '{"type":"text","sessionID":"S1","part":{"type":"text","text":"resumed and finished"}}'
  echo '{"type":"step_finish","sessionID":"S1","part":{"reason":"stop","tokens":{"input":2,"output":2},"cost":0.02}}'
  exit 0;;
esac
echo '{"type":"step_start","sessionID":"S1","part":{}}'
echo '{"type":"tool_use","sessionID":"S1","part":{"tool":"edit","state":{"status":"completed","input":{"filePath":"a.txt"}}}}'
printf 'one\\n' > a.txt
sleep "\${FAKE_SLEEP:-2}"
echo '{"type":"text","sessionID":"S1","part":{"type":"text","text":"finished normally"}}'
echo '{"type":"step_finish","sessionID":"S1","part":{"reason":"stop","tokens":{"input":1,"output":1},"cost":0.01}}'
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-live-"));
  bin = mkdtempSync(join(tmpdir(), "yxu-live-bin-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README"), "x\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
  fakeCli(bin, "opencode", FAKE);
  process.env.PATH = pathWith(bin, origPath);
  process.env.FAKE_LOG = join(bin, "calls");
  process.env.FAKE_SLEEP = "2";
});
afterEach(() => {
  process.env.PATH = origPath;
  delete process.env.FAKE_LOG;
  delete process.env.FAKE_SLEEP;
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

const profile = (o: Partial<AgentProfile> = {}): AgentProfile => ({ cli: "opencode", permission: "accept-edits", timeoutMs: 20_000, ...o });

/** Start a task and resolve with its id once its first tool call has streamed in. */
function startTask(p: AgentProfile = profile(), signal?: AbortSignal) {
  const events: { at: number; e: AgentEvent }[] = [];
  let id = "";
  let firstTool!: () => void;
  const ready = new Promise<void>((r) => (firstTool = r));
  const done = runTask({
    agentName: "oc",
    profile: p,
    prompt: "do the thing",
    cwd: root,
    signal,
    onStart: (t) => (id = t),
    onEvent: (_t, e) => {
      events.push({ at: Date.now(), e });
      if (e.kind === "tool") firstTool();
    },
  });
  return { done, events, ready: ready.then(() => id) };
}

describe("live tasks", () => {
  test("events stream while the agent works, not only at the end", async () => {
    const t0 = Date.now();
    const seen: string[] = [];
    const off = onLiveChange((id) => seen.push(id));
    const { done, events, ready } = startTask();
    const id = await ready;
    expect(Date.now() - t0).toBeLessThan(1800); // before the agent's 2s of work are over
    expect(liveTask(id)).toMatchObject({ state: "running", agent: "oc", sessionId: "S1" });
    expect(liveTask(id)!.events.map((e) => e.kind)).toEqual(["start", "tool"]);
    const r = await done;
    off();
    expect(r).toMatchObject({ ok: true, summary: "finished normally", filesChanged: ["a.txt"] });
    expect(events.find((x) => x.e.kind === "tool")!.at - t0).toBeLessThan(1800);
    expect(liveTask(id)).toBeUndefined(); // gone once finished
    expect(seen).toContain(id);
  }, 20_000);

  test("steer: the agent stops and continues its own session with the message", async () => {
    const { done, ready } = startTask();
    const id = await ready;
    expect(liveTask(id)!.steer("use the helper in utils.ts")).toBeUndefined();
    expect(liveTask(id)!.state).toBe("steering");
    const r = await done;
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("resumed and finished");
    expect(r.filesChanged.sort()).toEqual(["a.txt", "b.txt"]); // the work from before the steer is kept
    expect(r.usage).toMatchObject({ inputTokens: 2 }); // the killed segment reported nothing; the resumed one 2
    const calls = readFileSync(join(bin, "calls"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--session S1");
    expect(calls[1]).toContain("[A message from the user, who is watching you work] use the helper in utils.ts");
    expect(git(root, "show", `yxu/${r.taskId}:b.txt`)).toContain("use the helper in utils.ts");
  }, 20_000);

  test("pause and resume: the timeout doesn't count paused time", async () => {
    if (process.platform === "win32") return;
    process.env.FAKE_SLEEP = "1";
    const { done, ready } = startTask(profile({ timeoutMs: 2500 }));
    const id = await ready;
    expect(liveTask(id)!.pause()).toBeUndefined();
    expect(liveTask(id)!.state).toBe("paused");
    expect(liveTask(id)!.pause()).toBe("it is already paused");
    await Bun.sleep(2500); // longer than the whole timeout
    expect(liveTask(id)!.resume()).toBeUndefined();
    const r = await done;
    expect(r).toMatchObject({ ok: true, summary: "finished normally" });
  }, 20_000);

  test("take over: the agent stops, the user finishes in the worktree, /done hands it back", async () => {
    const { done, ready } = startTask();
    const id = await ready;
    const ctl = liveTask(id)!;
    expect(ctl.takeOver()).toBeUndefined();
    while (ctl.state !== "user") await Bun.sleep(20);
    expect(ctl.steer("x")).toContain("taken this task over");
    writeFileSync(join(ctl.worktree, "mine.txt"), "by hand\n");
    expect(ctl.done()).toBeUndefined();
    const r = await done;
    expect(r.ok).toBe(true);
    expect(r.filesChanged.sort()).toEqual(["a.txt", "mine.txt"]);
    expect(r.summary).toContain("[The user took over this task and finished it by hand");
  }, 20_000);

  test("a CLI that can't resume starts again in its worktree, told what happened; cancel still works while taken over", async () => {
    // generic agents have no session to resume
    const gen = profile({ cli: "generic", generic: { command: ["opencode", "{{task}}"], output: "text", summary: "last-paragraph", success: "exit-code" } });
    const { done } = startTask(gen);
    let id = "";
    while (!id) {
      await Bun.sleep(20);
      id = [...readCalls()].length ? (await Promise.resolve(lastLive())) : "";
    }
    await Bun.sleep(200);
    expect(liveTask(id)!.steer("smaller change please")).toBeUndefined();
    const r = await done;
    const calls = readCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("You were already working on this task when the user interrupted you.");
    expect(calls[1]).toContain("smaller change please");
    expect(r.filesChanged).toContain("a.txt");

    const ac = new AbortController();
    const second = startTask(profile(), ac.signal);
    const id2 = await second.ready;
    liveTask(id2)!.takeOver();
    while (liveTask(id2)?.state !== "user") await Bun.sleep(20);
    ac.abort();
    const r2 = await second.done;
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("cancelled");
    expect(existsSync(join(root, ".yxu", "worktrees", id2))).toBe(true); // what was done is kept for review
  }, 30_000);
});

const readCalls = () => (existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8").trim().split("\n") : []);
const lastLive = async () => liveTasks().at(-1)?.taskId ?? "";

describe("watching and stepping in from the interface", () => {
  test("/watch follows the running agent; /tell steers it; /takeover then /done hands it back", async () => {
    process.env.FAKE_SLEEP = "3";
    const cfg = parseConfig("agents:\n  oc: { cli: opencode }\ncontext: { repo_map: false }\n", join(root, "yxu.yaml"));
    const results: string[] = [];
    const engine: Engine = {
      async run({ session, abort, cfg: c, render }) {
        const ops = new TaskOps(c, root, session, { signal: abort.signal, hooks: render.hooks });
        const a = await ops.delegate("oc", "first task");
        const b = await ops.delegate("oc", "second task");
        results.push(a.summary, b.summary);
        return { runId: "r", ok: true, finalText: "ok", costUsd: 0, session } as RunOutcome;
      },
    };
    let frame: Frame = { rows: [] };
    const app = new App({
      cfg,
      root,
      theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
      engine,
      historyFile: null,
      catalog: testCatalog(),
      draw: (f) => (frame = f),
      size: () => ({ width: 160, height: 50 }),
      exit: () => {},
    });
    const screen = () => {
      app.render();
      return frame.rows.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    };
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(25);
      expect(cond()).toBe(true);
    };

    app.input("/watch\r");
    expect(screen()).toContain("No agent is running. Watching is on");
    app.input("go\r");
    await until(() => app.store.state.watch?.activity.some((a) => a.includes("edit a.txt")) ?? false);
    let s = screen();
    expect(s).toContain("W A T C H");
    expect(s).toContain("(following)");
    expect(s).toContain("✓ edit a.txt");
    await until(() => (app.store.state.watch?.files.length ?? 0) > 0);
    expect(app.store.state.watch!.files).toEqual([{ path: "a.txt", added: 1, removed: 0 }]);
    expect(screen()).toContain("+one");

    const first = app.store.state.watch!.taskId;
    app.input("/tell use tabs please\r");
    expect(app.store.state.entries.some((e) => e.kind === "notice" && e.text.startsWith("Told oc") && e.text.includes("use tabs please"))).toBe(true);

    // Following moves on to the second task: take it over, then hand it back.
    await until(() => liveTasksNow().length === 1 && liveTasksNow()[0]!.taskId !== first && app.store.state.watch?.taskId === liveTasksNow()[0]!.taskId);
    app.input("/takeover\r");
    await until(() => liveTasksNow()[0]?.state === "user");
    expect(screen()).toContain("yours — /done hands it back");
    writeFileSync(join(liveTasksNow()[0]!.worktree, "mine.txt"), "x\n");
    app.input("/done\r");
    await app.idle();
    expect(results[0]).toBe("resumed and finished");
    expect(results[1]).toContain("[The user took over this task");
    app.input("/watch off\r");
    expect(app.store.state.watch).toBeUndefined();
    app.dispose();
  }, 30_000);
});

const liveTasksNow = liveTasks;
