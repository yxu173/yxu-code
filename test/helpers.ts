import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { CLAUDE_MODELS, ModelCatalog, parseCommandCodeModels, parseOpencodeModels } from "../src/models.ts";

const fixture = (n: string) => readFileSync(join(import.meta.dir, "fixtures", n), "utf8");

/** A catalog fed from captured CLI output: no processes, no disk cache. */
export function testCatalog(over: Partial<Record<string, () => Promise<never>>> = {}) {
  return new ModelCatalog(null, async (cli) => {
    if (over[cli]) return over[cli]!();
    if (cli === "commandcode") return parseCommandCodeModels(fixture("commandcode-models.txt"));
    if (cli === "opencode") return parseOpencodeModels(fixture("opencode-models-verbose.txt"));
    return CLAUDE_MODELS;
  });
}

/**
 * Put a fake CLI named `name` in `bin`, running a POSIX sh script. On Windows it becomes what npm
 * installs there: an npm-style `.cmd` shim pointing at a JS launcher (which runs the script with
 * Git's sh), so tests also cover how yxu runs npm shims.
 */
export function fakeCli(bin: string, name: string, script: string) {
  if (process.platform !== "win32") {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
    return;
  }
  writeFileSync(join(bin, `${name}.sh`), script);
  writeFileSync(
    join(bin, `${name}.js`),
    `const r = require("node:child_process").spawnSync("sh", [require("node:path").join(__dirname, ${JSON.stringify(`${name}.sh`)}), ...process.argv.slice(2)], { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n`,
  );
  writeFileSync(join(bin, `${name}.cmd`), `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"node"  "%dp0%\\${name}.js" %*\r\n`);
}

/** PATH with `bin` first (";" on Windows). */
export const pathWith = (bin: string, rest = process.env.PATH ?? "") => `${bin}${delimiter}${rest}`;
