// Temporary: how a fake npm-style shim behaves on Windows CI.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCli, pathWith } from "../test/helpers.ts";
import { resolveArgv, start, which } from "../src/platform.ts";
const bin = mkdtempSync(join(tmpdir(), "dbg-"));
fakeCli(bin, "fake", `#!/bin/sh\nfor a; do last="$a"; done\necho "args=$#"\necho "last=$last"\npwd\n`);
process.env.PATH = pathWith(bin);
console.log("which fake:", which("fake"), "which sh:", which("sh"), "which node:", which("node"));
console.log("argv:", resolveArgv(["fake", "one", "two\nlines"]));
const env = { ...process.env };
console.log("env PATH keys:", Object.keys(env).filter((k) => k.toLowerCase() === "path"));
const r = await start(["fake", "one", "two\nlines"], { cwd: tmpdir(), env }).result;
console.log("code", r.code, "stdout", JSON.stringify(r.stdout), "stderr", JSON.stringify(r.stderr));
