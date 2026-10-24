import { afterEach, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { claudeExecutable, isCompiled, VERSION, which } from "../src/platform.ts";

const saved = process.env.YXU_CLAUDE_PATH;
afterEach(() => {
  if (saved === undefined) delete process.env.YXU_CLAUDE_PATH;
  else process.env.YXU_CLAUDE_PATH = saved;
});

test("version comes from package.json", () => {
  expect(VERSION).toBe(pkg.version);
});

test("from source, the Agent SDK picks its own Claude engine", () => {
  delete process.env.YXU_CLAUDE_PATH;
  expect(isCompiled()).toBe(false);
  expect(claudeExecutable()).toBeUndefined();
});

test("YXU_CLAUDE_PATH overrides the engine and must exist", () => {
  process.env.YXU_CLAUDE_PATH = which("sh")!;
  expect(claudeExecutable()).toBe(which("sh")!);
  process.env.YXU_CLAUDE_PATH = "/nonexistent/claude";
  expect(() => claudeExecutable()).toThrow(/missing file/);
});
