/** `yxu config …`: inspect and edit the configuration layers. */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname } from "node:path";
import { parseDocument, stringify } from "yaml";
import { CONFIG_VERSION } from "./config.ts";
import { migrateText, saveConfigPatch } from "./config-edit.ts";
import { explainRows } from "./config-explain.ts";
import { display, FILE_LAYERS, loadLayers, splitKey, type FileLayer } from "./config-layers.ts";
import { schemaText } from "./config-schema.ts";
import { repoRoot } from "./git.ts";

export const CONFIG_USAGE = `yxu config — layered configuration

Layers (later wins; maps merge, lists replace, null removes):
  built-in defaults → ~/.config/yxu/config.yaml (user) → yxu.yaml (project)
  → yxu.local.yaml (local, git-ignored) → YXU_* env → --set flags

Usage:
  yxu config                      layers and every setting with where it came from
  yxu config explain [key]        same, for one key or section (e.g. agents.coder)
  yxu config get <key>            effective value (YAML)
  yxu config set <key> <value> [--project|--local|--user]
                                  write a value (YAML syntax: 3, true, [a, b], null)
  yxu config unset <key> [--project|--local|--user]
  yxu config paths                the files behind each layer
  yxu config migrate [--write]    upgrade config files to version ${CONFIG_VERSION} (shows the diff)
  yxu config schema               print the JSON Schema (for editors)

Environment: YXU_ORCHESTRATOR_MODEL=sonnet, YXU_SETTINGS_CONCURRENCY=2, … (orchestrator,
settings, context and compact keys). Flags: --set key=value on run, tui, chat, mcp, delegate.
Default layer for set/unset: project.`;

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);

function layerFlag(values: Record<string, unknown>): FileLayer {
  const picked = FILE_LAYERS.filter((l) => values[l]);
  if (picked.length > 1) throw new Error("choose one of --project, --local, --user");
  return picked[0] ?? "project";
}

function parseValue(v: string): unknown {
  return parseDocument(v).toJS();
}

export async function configCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv[0] && !argv[0].startsWith("-") ? argv : ["explain", ...argv];
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      project: { type: "boolean" },
      local: { type: "boolean" },
      user: { type: "boolean" },
      write: { type: "boolean" },
      json: { type: "boolean" },
      set: { type: "string", multiple: true },
    },
  });
  const root = repoRoot(process.cwd());

  switch (sub) {
    case "explain":
    case "show": {
      const loaded = loadLayers(root, { sets: values.set });
      const key = positionals[0];
      const rows = explainRows(loaded, root, key);
      if (key && !rows.length) throw new Error(`no setting "${key}"`);
      if (values.json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      if (!key) {
        console.log("layers (later wins):");
        for (const l of loaded.layers) {
          const what = l.pack ? display(dirname(l.file!), root) : l.file ? display(l.file, root) : l.name === "defaults" ? "built-in" : l.name === "env" ? "YXU_* variables" : "--set";
          const state = l.file && !l.pack ? (l.exists ? (l.version === undefined ? "  (no version: run `yxu config migrate`)" : "") : "  (none)") : "";
          const n = Object.keys(l.data).length;
          const label = l.pack ? `${l.name === "packs" ? "pack" : "user pack"} ${l.pack}` : l.name;
          console.log(`  ${label.padEnd(9)} ${what}${state}${!l.file && l.name !== "defaults" ? dim(n ? `  ${n} section(s)` : "  (none)") : ""}`);
        }
        console.log("");
      }
      const width = Math.min(44, Math.max(...rows.map((r) => r.key.length)));
      for (const r of rows) console.log(`${r.key.padEnd(width)}  ${r.value}  ${dim(`← ${r.from}`)}`);
      return 0;
    }
    case "get": {
      const key = positionals[0] ?? usage("config get <key>");
      const cfg = loadLayers(root, { sets: values.set }).config as unknown as Record<string, unknown>;
      let v: unknown = cfg;
      for (const k of splitKey(key)) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
      if (v === undefined) throw new Error(`no setting "${key}"`);
      process.stdout.write(typeof v === "object" ? stringify(v) : `${v}\n`);
      return 0;
    }
    case "set":
    case "unset": {
      const key = positionals[0] ?? usage(`config ${sub} <key>${sub === "set" ? " <value>" : ""}`);
      if (sub === "set" && positionals.length < 2) usage("config set <key> <value>");
      const layer = layerFlag(values);
      const value = sub === "set" ? parseValue(positionals.slice(1).join(" ")) : undefined;
      const file = saveConfigPatch(root, [{ path: splitKey(key), value }], layer);
      console.log(`✓ ${sub === "set" ? `${key} = ${JSON.stringify(value)}` : `removed ${key}`} in ${display(file, root)} (${layer})`);
      const loaded = loadLayers(root);
      const winner = explainRows(loaded, root, key)[0];
      if (winner && winner.layer !== layer && sub === "set") console.log(dim(`  note: the effective value comes from ${winner.from}`));
      return 0;
    }
    case "paths": {
      const loaded = loadLayers(root);
      for (const l of loaded.layers.filter((x) => x.file && !x.pack)) {
        console.log(`${l.name.padEnd(8)} ${l.file}${l.exists ? `  (version ${l.version ?? "not set"})` : "  (not created)"}`);
      }
      return 0;
    }
    case "migrate": {
      let pending = 0;
      for (const l of loadLayers(root).layers) {
        if (!l.file || !l.exists || l.pack) continue;
        const m = migrateText(readFileSync(l.file, "utf8"));
        if (m.before === m.after) {
          console.log(`✓ ${display(l.file, root)} is at version ${m.to}`);
          continue;
        }
        pending++;
        console.log(`${values.write ? "✓ migrated" : "→ would migrate"} ${display(l.file, root)}: version ${m.from || "(none)"} → ${m.to}`);
        console.log(dim(lineDiff(m.before, m.after)));
        if (values.write) writeFileSync(l.file, m.after);
      }
      if (pending && !values.write) console.log("\nrun `yxu config migrate --write` to apply");
      return 0;
    }
    case "schema":
      process.stdout.write(schemaText());
      return 0;
    case "help":
    case "--help":
    case "-h":
      console.log(CONFIG_USAGE);
      return 0;
    default:
      console.error(CONFIG_USAGE);
      return 1;
  }
}

function usage(u: string): never {
  throw new Error(`usage: yxu ${u}`);
}

/** Minimal +/- diff for small config edits (changed lines only). */
export function lineDiff(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (j < y.length && !x.slice(i).includes(y[j]!)) {
      out.push(`  + ${y[j++]}`);
    } else if (i < x.length) {
      out.push(`  - ${x[i++]}`);
    } else {
      out.push(`  + ${y[j++]}`);
    }
  }
  return out.join("\n");
}
