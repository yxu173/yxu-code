/**
 * The small expression language used in workflow conditions and `{{…}}` templates.
 * No eval: paths, literals, comparisons and boolean logic only.
 *
 *   verify.ok                      plan.tasks.length > 3
 *   !lint.ok || inputs.force       review.summary contains "security"
 *   inputs.env == "prod"           (a.ok && b.ok) || c.exit_code == 0
 *
 * Identifiers may contain "-" (step ids do); there is no subtraction.
 */

type Tok = { t: "num" | "str" | "id" | "op"; v: string };

const OPS = ["&&", "||", "==", "!=", ">=", "<=", ">", "<", "!", "(", ")", ".", "[", "]"];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        s += src[j++];
      }
      if (j >= src.length) throw new Error(`unterminated string in "${src}"`);
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    // After "." a number is an index (tasks.0.title), never a decimal.
    const num = (out.at(-1)?.v === "." ? /^\d+/ : /^\d+(\.\d+)?/).exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][\w-]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    throw new Error(`unexpected "${c}" in "${src}"`);
  }
  return out;
}

export type Scope = Record<string, unknown>;

function prop(obj: unknown, key: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (key === "length" && (typeof obj === "string" || Array.isArray(obj))) return obj.length;
  if (typeof obj !== "object") return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

/** Evaluate an expression against a scope. Unknown paths are undefined, not errors. */
export function evaluate(src: string, scope: Scope): unknown {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p];
    if (!t || (v !== undefined && t.v !== v)) throw new Error(`expected ${v ?? "a value"} in "${src}"`);
    p++;
    return t;
  };

  const or = (): unknown => {
    let l = and();
    while (peek()?.v === "||") {
      p++;
      const r = and();
      l = truthy(l) ? l : r;
    }
    return l;
  };
  const and = (): unknown => {
    let l = not();
    while (peek()?.v === "&&") {
      p++;
      const r = not();
      l = truthy(l) ? r : l;
    }
    return l;
  };
  const not = (): unknown => {
    if (peek()?.t === "op" && peek()?.v === "!") {
      p++;
      return !truthy(not());
    }
    return cmp();
  };
  const cmp = (): unknown => {
    const l = primary();
    const t = peek();
    if (t?.t === "id" && t.v === "contains") {
      p++;
      const r = primary();
      if (Array.isArray(l)) return l.some((x) => x === r || String(x) === String(r));
      return typeof l === "string" && l.includes(String(r ?? ""));
    }
    if (t?.t === "op" && ["==", "!=", ">=", "<=", ">", "<"].includes(t.v)) {
      p++;
      const r = primary();
      switch (t.v) {
        case "==":
          return l === r || (l !== undefined && r !== undefined && l !== null && r !== null && String(l) === String(r));
        case "!=":
          return !(l === r || (l !== undefined && r !== undefined && l !== null && r !== null && String(l) === String(r)));
        case ">":
          return Number(l) > Number(r);
        case "<":
          return Number(l) < Number(r);
        case ">=":
          return Number(l) >= Number(r);
        case "<=":
          return Number(l) <= Number(r);
      }
    }
    return l;
  };
  const primary = (): unknown => {
    const t = eat();
    if (t.t === "num") return Number(t.v);
    if (t.t === "str") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = or();
      eat(")");
      return v;
    }
    if (t.t !== "id") throw new Error(`unexpected "${t.v}" in "${src}"`);
    if (t.v === "true") return true;
    if (t.v === "false") return false;
    if (t.v === "null") return null;
    let v: unknown = prop(scope, t.v);
    for (;;) {
      const n = peek();
      if (n?.v === ".") {
        p++;
        const k = eat();
        if (k.t !== "id" && k.t !== "num") throw new Error(`bad property after "." in "${src}"`);
        v = prop(v, k.v);
      } else if (n?.v === "[") {
        p++;
        const k = or();
        eat("]");
        v = prop(v, String(k));
      } else break;
    }
    return v;
  };

  if (!toks.length) return undefined;
  const v = or();
  if (p < toks.length) throw new Error(`unexpected "${toks[p]!.v}" in "${src}"`);
  return v;
}

/** A condition: "{{ expr }}" or a bare expression. */
export function condition(src: string | boolean, scope: Scope): boolean {
  if (typeof src === "boolean") return src;
  const m = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(src);
  return truthy(evaluate(m ? m[1]! : src, scope));
}

/** Text for a value: step results show their summary, lists one item per line. */
export function toText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(toText).join("\n");
  if (typeof v === "object" && typeof (v as { summary?: unknown }).summary === "string") return (v as { summary: string }).summary;
  return JSON.stringify(v);
}

/** Quote one value for a POSIX shell. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Fill `{{ expr }}` placeholders. With `shell`, every value is quoted (lists: one word per item). */
export function render(tpl: string, scope: Scope, opts: { shell?: boolean } = {}): string {
  return tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr: string) => {
    const v = evaluate(expr, scope);
    if (!opts.shell) return toText(v);
    if (Array.isArray(v)) return v.map((x) => shellQuote(toText(x))).join(" ");
    return shellQuote(toText(v));
  });
}
