import { readFileSync } from "node:fs";
import { join } from "node:path";
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
