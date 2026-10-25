/**
 * Embed the starter packs in packs/ into src/builtin-packs.gen.ts, so `yxu add python` works
 * offline and from the compiled binary. Run `bun run packs` after editing packs/.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const GEN_FILE = join(ROOT, "src", "builtin-packs.gen.ts");

export function generatePacks(): string {
  const packsDir = join(ROOT, "packs");
  const packs: Record<string, Record<string, string>> = {};
  for (const name of readdirSync(packsDir).sort()) {
    const dir = join(packsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const files: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of readdirSync(d).sort()) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else files[relative(dir, p).split(sep).join("/")] = readFileSync(p, "utf8").replaceAll("\r\n", "\n");
      }
    };
    walk(dir);
    packs[name] = files;
  }
  return `// Generated from packs/ by \`bun run packs\`. Do not edit.\nexport const BUILTIN_PACKS: Record<string, Record<string, string>> = ${JSON.stringify(packs, null, 2)};\n`;
}

if (import.meta.main) {
  writeFileSync(GEN_FILE, generatePacks());
  console.log(`wrote ${relative(ROOT, GEN_FILE)}`);
}
