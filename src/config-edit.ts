import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { DEFAULT_YAML, parseConfig, type Config } from "./config.ts";

export type ConfigPatch = { path: string[]; value: unknown }[];

/**
 * Apply changes to the yxu.yaml that `cfg` came from, keeping comments and layout.
 * When running on built-in defaults, a project yxu.yaml is created first.
 * The result is validated before anything is written. Returns the file written.
 */
export function saveConfigPatch(cfg: Config, root: string, patch: ConfigPatch): string {
  const file = existsSync(cfg.source) ? cfg.source : join(root, "yxu.yaml");
  const text = existsSync(file) ? readFileSync(file, "utf8") : DEFAULT_YAML;
  const doc = parseDocument(text);
  for (const { path, value } of patch) {
    if (value === undefined) doc.deleteIn(path);
    else doc.setIn(path, value);
  }
  const out = doc.toString();
  parseConfig(out, file); // throws with a readable message if the change is invalid
  writeFileSync(file, out);
  return file;
}

/** The context/compact settings as a patch (what `/context save` persists). */
export function contextPatch(cfg: Config): ConfigPatch {
  const c = cfg.context;
  const k = cfg.compact;
  return [
    { path: ["context", "memory"], value: c.memory },
    { path: ["context", "project_instructions"], value: c.project_instructions },
    { path: ["context", "include"], value: c.include },
    { path: ["context", "notes"], value: c.notes?.trim() ? c.notes : undefined },
    { path: ["compact", "auto"], value: k.auto },
    { path: ["compact", "window"], value: k.window },
    { path: ["compact", "instructions"], value: k.instructions?.trim() ? k.instructions : undefined },
    { path: ["compact", "warn_at"], value: k.warn_at },
  ];
}
