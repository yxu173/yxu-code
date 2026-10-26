import { describe, expect, test } from "bun:test";
import { taskPrompt } from "../src/prompts.ts";
import { DEFAULT_YAML, getWorkflow, parseConfig, parseDuration, toProfile } from "../src/config.ts";
import { orchestratorPrompt } from "../src/orchestrator/run.ts";

describe("parseDuration", () => {
  test("units", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration(30)).toBe(30_000);
    expect(() => parseDuration("soon")).toThrow();
  });
});

describe("config", () => {
  test("default yaml is valid", () => {
    const cfg = parseConfig(DEFAULT_YAML, "default");
    expect(cfg.orchestrator.model).toBe("opus");
    expect(cfg.agents.coder).toMatchObject({ cli: "commandcode", model: "deepseek/deepseek-v4-flash" });
    expect(Object.keys(cfg.agents)).toEqual(["scout", "coder", "builder", "tester", "debugger", "reviewer", "resolver", "docs", "expert", "backup"]);
    expect(cfg.agents.scout).toMatchObject({ permission: "plan" });
    expect(cfg.agents.scout!.instructions).toContain("never change it");
    expect(cfg.settings.resolver).toBe("resolver");
    expect(toProfile(cfg.agents.coder!).timeoutMs).toBe(900_000);
    expect(cfg.settings.max_diff_chars).toBe(12_000);
  });

  test("minimal config gets defaults", () => {
    const cfg = parseConfig("agents:\n  a:\n    cli: opencode\n", "x");
    expect(cfg.orchestrator.model).toBe("opus");
    expect(getWorkflow(cfg, undefined)).toMatchObject({ name: "default", mode: "auto" });
  });

  test("rejects unknown cli", () => {
    expect(() => parseConfig("agents:\n  a:\n    cli: cursor\n", "x")).toThrow(/unknown cli "cursor"/);
  });

  test("rejects workflow referencing unknown agent", () => {
    const y = "agents:\n  a:\n    cli: claude\nworkflows:\n  w:\n    allowed_agents: [b]\n";
    expect(() => parseConfig(y, "x")).toThrow(/unknown agent "b"/);
  });

  test("unknown workflow name errors", () => {
    const cfg = parseConfig("agents:\n  a:\n    cli: claude\n", "x");
    expect(() => getWorkflow(cfg, "nope")).toThrow(/unknown workflow/);
  });

  test("workflow instructions reach the orchestrator prompt", () => {
    const cfg = parseConfig(DEFAULT_YAML, "default");
    const p = orchestratorPrompt(getWorkflow(cfg, "default"));
    expect(p).toContain("`scout`");
    expect(p).toContain("yxu apply");
  });
});

describe("task prompts", () => {
  test("read-only agents get their own preamble; an agent's instructions come before the task", () => {
    const edit = taskPrompt("/nonexistent", { permission: "accept-edits", instructions: "Role: coder." }, "do x");
    expect(edit).toContain("Make the code changes directly");
    expect(edit.indexOf("Role: coder.")).toBeLessThan(edit.indexOf("TASK:\ndo x"));
    const ro = taskPrompt("/nonexistent", { permission: "plan" }, "find y");
    expect(ro).toContain("Do not create, edit or delete files");
    expect(ro).not.toContain("Make the code changes directly");
    expect(ro.endsWith("TASK:\nfind y")).toBe(true);
  });
});

describe("defaults", () => {
  test("verify_timeout default is 10 minutes in ms; explicit values are parsed", () => {
    expect(parseConfig("agents:\n  a: { cli: claude }\n", "x").settings.verify_timeout).toBe(600_000);
    expect(parseConfig("agents:\n  a: { cli: claude }\nsettings:\n  verify_timeout: 2m\n", "x").settings.verify_timeout).toBe(120_000);
  });
});
