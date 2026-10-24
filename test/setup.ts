// Isolate tests from the developer's own ~/.config/yxu, model cache and YXU_* settings.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "yxu-test-home-"));
process.env.XDG_CONFIG_HOME = join(home, "config");
process.env.XDG_CACHE_HOME = join(home, "cache");
for (const k of Object.keys(process.env)) if (/^YXU_(ORCHESTRATOR|SETTINGS|CONTEXT|COMPACT)_/.test(k)) delete process.env[k];
