/** `yxu config explain` / `/config`: each effective setting and the layer that set it. */
import { originOf, type Loaded } from "./config-layers.ts";

export interface ExplainRow {
  key: string;
  value: string;
  layer: string;
  from: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function leaves(v: unknown, prefix: string, out: [string, unknown][]) {
  if (isObj(v) && Object.keys(v).length) {
    for (const [k, child] of Object.entries(v)) leaves(child, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out.push([prefix, v]);
  }
}

function get(obj: unknown, key: string): unknown {
  let o = obj;
  for (const k of key.split(".")) {
    if (!isObj(o)) return undefined;
    o = o[k];
  }
  return o;
}

export function formatValue(v: unknown, max = 70): string {
  const s = typeof v === "string" ? (/[\s:#]|^$/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v);
  const one = (s ?? "undefined").replace(/\\n/g, "⏎");
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const LABEL: Record<string, string> = { defaults: "built-in default", env: "environment (YXU_*)", flags: "command-line flag" };

/** Rows for every leaf setting, or only those at/under `key`. */
export function explainRows(loaded: Loaded, root: string, key?: string): ExplainRow[] {
  const { source: _s, origins: _o, ...effective } = loaded.config;
  const all: [string, unknown][] = [];
  leaves(effective, "", all);
  const rows: ExplainRow[] = [];
  for (const [k, v] of all) {
    if (key && k !== key && !k.startsWith(`${key}.`)) continue;
    const o = originOf(loaded, k, root);
    // Show what was written (e.g. "15m"), not the parsed form (900000).
    const written = get(loaded.raw, k);
    rows.push({ key: k, value: formatValue(written !== undefined && !isObj(written) ? written : v), layer: o.layer, from: o.file ?? LABEL[o.layer] ?? o.layer });
  }
  return rows;
}
