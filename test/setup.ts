// Isolate tests from the developer's own ~/.config/yxu, model cache and YXU_* settings.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "yxu-test-home-"));
process.env.XDG_CONFIG_HOME = join(home, "config");
process.env.XDG_CACHE_HOME = join(home, "cache");
process.env.XDG_DATA_HOME = join(home, "data"); // sessions
delete process.env.YXU_DATA_DIR;
for (const k of Object.keys(process.env)) if (/^YXU_(ORCHESTRATOR|SETTINGS|CONTEXT|COMPACT)_/.test(k)) delete process.env[k];
