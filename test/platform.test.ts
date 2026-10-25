import { afterEach, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { join } from "node:path";
import { claudeExecutable, isCompiled, npmShimTarget, VERSION, which } from "../src/platform.ts";

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

test("npm .cmd shims on Windows are run as the script they point to", () => {
  const shim = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*\r\n`;
  expect(npmShimTarget(shim, join("C:", "npm", "opencode.cmd"))).toBe(join("C:", "npm", "node_modules", "opencode-ai", "bin", "opencode"));
  expect(npmShimTarget(`@"%~dp0\\tool.exe" %*`, join("D:", "bin", "tool.cmd"))).toBe(join("D:", "bin", "tool.exe"));
  expect(npmShimTarget("@echo hi", "x.cmd")).toBeUndefined();
});
