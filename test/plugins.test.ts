import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLayers } from "../src/config-layers.ts";
import { git, YXU_IDENTITY } from "../src/git.ts";
import { runHooks } from "../src/hooks.ts";
import { runPipeline } from "../src/orchestrator/pipeline.ts";
import { extractJson } from "../src/orchestrator/providers.ts";
import type { OrchestratorRender } from "../src/orchestrator/run.ts";
import { addPack } from "../src/pack-install.ts";
import { loadPlugins, setApproval } from "../src/plugins.ts";
import { runTask } from "../src/runner.ts";
import { toProfile } from "../src/config.ts";
import { App } from "../src/tui/app.ts";
import { createTheme } from "../src/tui/theme.ts";
import type { Frame } from "../src/tui/view.ts";
import { testCatalog } from "./helpers.ts";

let root: string;
let home: string;
const silent: OrchestratorRender = { assistantText() {}, toolCall() {}, hooks: {} };
const BUN = JSON.stringify(process.execPath);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-plugins-"));
  home = mkdtempSync(join(tmpdir(), "yxu-plugins-home-"));
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.XDG_CACHE_HOME = join(home, "cache");
  delete process.env.YXU_TRUST;
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "# x\n");
  writeFileSync(join(root, "yxu.yaml"), "agents:\n  coder: { cli: claude, model: haiku }\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
});
afterEach(() => {
  // Windows keeps a folder busy while a process (e.g. a panel refresh) still runs in it.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const write = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
const userPlugin = (name: string, body: string) => write(join(home, "config", "yxu", "plugins", `${name}.ts`), body);
const projectPlugin = (name: string, body: string) => write(join(root, ".yxu", "plugins", `${name}.ts`), body);

/** A plugin with every kind of contribution: an agent that writes a file, and an orchestrator that plans two tasks. */
const FULL = `
export default {
  name: "full",
  apiVersion: 1,
  commands: [{ name: "hello", description: "say hi", run: (ctx, args) => ctx.note("hi " + args.join(" ")) }],
  panel: [{ title: "stats", render: () => ["3 things"] }],
  hooks: {
    before_run: (ctx, e) => e.goal !== "blocked",
    on_complete: (ctx) => ctx.data.set("done", true),
  },
  agents: [{
    cli: "writer",
    command: (task) => [${BUN}, "-e", "const t = process.argv.at(-1); const f = (t.match(/FILE (\\\\S+)/) || [])[1] || 'out.txt'; require('fs').writeFileSync(f, 'written\\\\n'); console.log('wrote ' + f)", task.prompt],
    parse: (stdout, stderr, code) => ({ events: [], result: { ok: code === 0, summary: stdout.trim(), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }),
  }],
  orchestrators: [{
    name: "scripted",
    ask: async (req) => req.schema.properties.tasks
      ? { value: { summary: "two files", tasks: [{ title: "a", task: "FILE a.txt" }, { title: "b", task: "FILE b.txt" }] }, costUsd: 0.01 }
      : { value: { approved: true, summary: "fine", fixes: [] } },
  }],
};
`;

describe("loading", () => {
  test("a user plugin loads and registers everything it adds", () => {
    userPlugin("full", FULL);
    const reg = loadPlugins(root);
    expect(reg.entries.map((e) => [e.id, e.status, e.error])).toEqual([["full", "loaded", undefined]]);
    expect(reg.commands.map((c) => `${c.plugin}:${c.command.name}`)).toEqual(["full:hello"]);
    expect(reg.panels.map((p) => p.panel.title)).toEqual(["stats"]);
    expect([...reg.agents.keys()]).toEqual(["writer"]);
    expect([...reg.orchestrators.keys()]).toEqual(["scripted"]);
  });

  test("a repo's plugin waits for approval, and again after its code changes; YXU_TRUST=1 loads it", () => {
    projectPlugin("full", FULL);
    let e = loadPlugins(root).entries[0]!;
    expect(e.status).toBe("pending");
    expect(e.plugin).toBeUndefined();

    setApproval(e.path, true);
    expect(loadPlugins(root).entries[0]!.status).toBe("loaded");

    projectPlugin("full", FULL.replace("say hi", "say hello"));
    expect(loadPlugins(root).entries[0]!.status).toBe("changed");
    expect(loadPlugins(root, { ...process.env, YXU_TRUST: "1" }).entries[0]!.status).toBe("loaded");

    setApproval(e.path, true);
    e = loadPlugins(root).entries[0]!;
    expect(e.status).toBe("loaded");
    expect(e.plugin?.commands?.[0]?.description).toBe("say hello"); // the new code, not a cached module
  });

  test("broken plugins are reported, not fatal", () => {
    userPlugin("future", `export default { name: "future", apiVersion: 2 };`);
    userPlugin("noname", `export default { apiVersion: 1 };`);
    userPlugin("norun", `export default { name: "norun", apiVersion: 1, commands: [{ name: "x" }] };`);
    userPlugin("throws", `throw new Error("boom");`);
    userPlugin("builtin", `export default { name: "builtin", apiVersion: 1, agents: [{ cli: "claude", command() {}, parse() {} }] };`);
    userPlugin("twin", `export default { name: "future2", apiVersion: 1 };`);
    userPlugin("twin2", `export default { name: "future2", apiVersion: 1 };`);
    const errors = Object.fromEntries(loadPlugins(root).entries.map((e) => [e.id, e.error ?? e.status]));
    expect(errors.future).toMatch(/needs plugin API 2; this yxu has 1/);
    expect(errors.noname).toMatch(/name must be lowercase words/);
    expect(errors.norun).toMatch(/\/x needs run/);
    expect(errors.throws).toMatch(/boom/);
    expect(errors.builtin).toMatch(/"claude" is built in/);
    expect(errors.twin).toBe("loaded");
    expect(errors.twin2).toMatch(/already named future2/);
    expect(() => loadLayers(root)).not.toThrow();
  });
});

describe("what plugins add", () => {
  test("an agent cli: valid in config only while its plugin is loaded, and it runs like a built-in", async () => {
    writeFileSync(join(root, "yxu.yaml"), "agents:\n  w: { cli: writer }\n");
    expect(() => loadLayers(root)).toThrow(/unknown cli "writer".*yxu plugins/s);
    userPlugin("full", FULL);
    const cfg = loadLayers(root).config;
    const r = await runTask({ agentName: "w", profile: toProfile(cfg.agents.w!), prompt: "FILE hello.txt", cwd: root });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("wrote hello.txt");
    expect(r.filesChanged).toEqual(["hello.txt"]);
  });

  test("an orchestrator: a whole pipeline runs with a plugin planner and a plugin agent, no Claude", async () => {
    userPlugin("full", FULL);
    writeFileSync(
      join(root, "yxu.yaml"),
      `orchestrator: { provider: scripted }
agents:
  w: { cli: writer }
workflows:
  build:
    mode: pipeline
    steps:
      - { id: plan, type: plan }
      - { id: work, type: delegate, agent: w, for_each: plan }
      - { id: review, type: review, fix_agent: w }
`,
    );
    const cfg = loadLayers(root).config;
    const out = await runPipeline({ goal: "make two files", cfg, workflow: { ...cfg.workflows.build!, name: "build" }, root, render: silent, abort: new AbortController() });
    expect(out.ok).toBe(true);
    expect(out.costUsd).toBeCloseTo(0.01);
    const head = out.headTaskId!;
    expect(git(root, "show", `yxu/${head}:a.txt`)).toBe("written");
    expect(git(root, "show", `yxu/${head}:b.txt`)).toBe("written");
  });

  test("provider names are checked; auto workflows refuse a non-Claude provider", async () => {
    writeFileSync(join(root, "yxu.yaml"), "orchestrator: { provider: nope }\nagents:\n  coder: { cli: claude }\n");
    expect(() => loadLayers(root)).toThrow(/orchestrator.provider "nope"/);
    writeFileSync(join(root, "yxu.yaml"), "orchestrator: { provider: agent }\nagents:\n  coder: { cli: claude }\n");
    expect(() => loadLayers(root)).toThrow(/needs orchestrator.agent/);
    writeFileSync(join(root, "yxu.yaml"), "orchestrator: { provider: agent, agent: coder }\nagents:\n  coder: { cli: claude }\n");
    const cfg = loadLayers(root).config;
    const { runOrchestrator } = await import("../src/orchestrator/run.ts");
    await expect(runOrchestrator({ goal: "x", cfg, workflow: { mode: "auto", name: "default" } as never, root, render: silent, abort: new AbortController() })).rejects.toThrow(/needs orchestrator.provider: claude/);
  });

  test("hooks: a before_run plugin hook can block; others run with the event", async () => {
    userPlugin("full", FULL);
    const cfg = loadLayers(root).config;
    expect((await runHooks(cfg, "before_run", { goal: "fine" }, { cwd: root })).ok).toBe(true);
    const blocked = await runHooks(cfg, "before_run", { goal: "blocked" }, { cwd: root });
    expect(blocked.ok).toBe(false);
    expect(blocked.failed[0]!.result.output).toMatch(/plugin full blocked before_run/);
    await runHooks(cfg, "on_complete", {}, { cwd: root });
    expect(JSON.parse(readFileSync(join(root, ".yxu", "plugin-data", "full.json"), "utf8"))).toEqual({ done: true });
  });
});

describe("the agent orchestrator", () => {
  test("finds the answer in a reply", () => {
    expect(extractJson('Plan:\n```json\n{"a": 1}\n```\nthanks')).toEqual({ a: 1 });
    expect(extractJson('first {"a": 1} then {"b": {"c": "}"}} end')).toEqual({ b: { c: "}" } });
    expect(extractJson("no json here")).toBeUndefined();
  });

  test("one of your agents plans (read-only, retried once when the answer doesn't fit)", async () => {
    // An agent that answers badly first, then with a valid plan; the orchestrator agent's worktree is discarded.
    userPlugin(
      "answers",
      `let n = 0;
export default {
  name: "answers",
  apiVersion: 1,
  agents: [{
    cli: "answerer",
    command: (task, profile) => [${BUN}, "-e", "console.log(process.argv.at(-1))", (++n === 1 ? "not json" : 'Here:\\n\`\`\`json\\n{"summary":"s","tasks":[{"title":"t","task":"FILE z.txt"}]}\\n\`\`\`') + " perm=" + profile.permission],
    parse: (stdout, stderr, code) => ({ events: [], result: { ok: code === 0, summary: stdout.trim(), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } }),
  }],
};`,
    );
    userPlugin("full", FULL);
    writeFileSync(
      join(root, "yxu.yaml"),
      `orchestrator: { provider: agent, agent: brain }
agents:
  brain: { cli: answerer }
  w: { cli: writer }
workflows:
  build:
    mode: pipeline
    steps:
      - { id: plan, type: plan }
      - { id: work, type: delegate, agent: w, for_each: plan }
`,
    );
    const cfg = loadLayers(root).config;
    const said: string[] = [];
    const out = await runPipeline({ goal: "one file", cfg, workflow: { ...cfg.workflows.build!, name: "build" }, root, render: { ...silent, assistantText: (t) => said.push(t) }, abort: new AbortController() });
    expect(out.ok).toBe(true);
    expect(said.some((t) => /asking brain \(orchestrator\) again/.test(t))).toBe(true);
    expect(git(root, "show", `yxu/${out.headTaskId}:z.txt`)).toBe("written");
    expect(git(root, "worktree", "list").split("\n").length).toBe(2); // the repo + the kept task, not the questions
  });
});

describe("packs with plugins, in the interface", () => {
  function appFor() {
    let frame: Frame = { rows: [] };
    const app = new App({
      cfg: loadLayers(root).config,
      root,
      theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }),
      engine: { run: async (o) => ({ runId: "r", ok: true, finalText: `ran: ${o.goal}`, costUsd: 0, session: o.session! }) as never },
      historyFile: null,
      catalog: testCatalog(),
      draw: (f) => (frame = f),
      size: () => ({ width: 160, height: 60 }),
      exit: () => {},
    });
    const screen = () => {
      app.render();
      return frame.rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    };
    return { app, screen };
  }

  test("the example todos pack: installing approves its plugin; it adds a panel section and commands", async () => {
    writeFileSync(join(root, "src.py"), "def f():\n    pass  # TODO: handle errors\n# FIXME(me): slow\n");
    git(root, "add", ".");
    git(root, ...YXU_IDENTITY, "commit", "-qm", "todos");
    const printed: string[] = [];
    await addPack(root, join(import.meta.dir, "..", "examples", "todos"), { scope: "project" }, { print: (l) => printed.push(l), dim: (s) => s });
    expect(printed.join("\n")).toMatch(/plugins   todos \(code\)[\s\S]*plugin todos: code that runs inside yxu/);
    expect(loadPlugins(root).entries.map((e) => [e.id, e.pack, e.status])).toEqual([["todos", "todos", "loaded"]]);

    const { app, screen } = appFor();
    await app.refreshPanels();
    let s = screen();
    expect(s).toContain("T O D O S");
    expect(s).toContain("2 open");
    expect(s).toContain("src.py:2  TODO: handle errors");

    await app.runPluginCommand("todos", app.cfg.plugins!.commands.find((c) => c.command.name === "list")!.command, []);
    s = screen();
    expect(s).toContain("Open TODOs");
    expect(s).toMatch(/2\. .*src\.py:3.* FIXME\(me\): slow/);

    app.runCommand("/todos:fix 1");
    await new Promise((r) => setTimeout(r, 300));
    s = screen();
    expect(s).toContain('Resolve the comment "TODO: handle errors" at src.py:2');
    await app.refreshPanels();
    expect(screen()).toContain("2 open · 1 handed off");
    app.dispose();
  });

  test("a teammate's checkout: the pack's plugin waits until they approve it", async () => {
    await addPack(root, join(import.meta.dir, "..", "examples", "todos"), { scope: "project" }, { print: () => {}, dim: (s) => s });
    rmSync(join(home, "config", "yxu", "plugins.json")); // a different person
    const { app, screen } = appFor();
    expect(screen()).toContain("Plugins wait for your approval");
    expect(app.cfg.plugins!.commands).toEqual([]);
    app.runCommand("/plugins approve");
    expect(screen()).toContain("Approved todos");
    expect(app.cfg.plugins!.commands.map((c) => c.command.name)).toEqual(["list", "fix"]);
    await app.refreshPanels(); // let the panel's git grep finish before the repo is removed
    app.dispose();
  });
});
