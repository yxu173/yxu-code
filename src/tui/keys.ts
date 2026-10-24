export type KeyName =
  | "char"
  | "enter"
  | "newline"
  | "backspace"
  | "delete"
  | "tab"
  | "backtab"
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "paste";

export interface Key {
  name: KeyName;
  /** For "char": the character. For "paste": the pasted text. */
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const CSI_FINAL: Record<string, KeyName> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const CSI_TILDE: Record<string, KeyName> = {
  "1": "home",
  "7": "home",
  "4": "end",
  "8": "end",
  "3": "delete",
  "5": "pageup",
  "6": "pagedown",
};

/** xterm modifier parameter: 1 + (shift 1 | alt 2 | ctrl 4). */
function mods(param: string | undefined): Pick<Key, "ctrl" | "alt" | "shift"> {
  const m = Math.max(0, Number(param ?? "1") - 1);
  const out: Pick<Key, "ctrl" | "alt" | "shift"> = {};
  if (m & 1) out.shift = true;
  if (m & 2) out.alt = true;
  if (m & 4) out.ctrl = true;
  return out;
}

/** Stateful decoder: terminal input arrives in arbitrary chunks (pastes can span several). */
export class KeyParser {
  private pasting = false;
  private pasteBuf = "";
  private pending = "";

  feed(chunk: string): Key[] {
    const keys: Key[] = [];
    let s = this.pending + chunk;
    this.pending = "";

    while (s.length) {
      if (this.pasting) {
        const end = s.indexOf(PASTE_END);
        if (end === -1) {
          this.pasteBuf += s;
          s = "";
          break;
        }
        this.pasteBuf += s.slice(0, end);
        keys.push({ name: "paste", text: this.pasteBuf.replace(/\r\n?/g, "\n") });
        this.pasteBuf = "";
        this.pasting = false;
        s = s.slice(end + PASTE_END.length);
        continue;
      }
      if (s.startsWith(PASTE_START)) {
        this.pasting = true;
        s = s.slice(PASTE_START.length);
        continue;
      }

      const ch = s[0]!;
      if (ch === "\x1b") {
        const r = this.escape(s);
        if (!r) {
          // Incomplete sequence at the end of the chunk: wait for more input.
          this.pending = s;
          break;
        }
        keys.push(r.key);
        s = s.slice(r.len);
        continue;
      }

      const cp = s.codePointAt(0)!;
      const len = cp > 0xffff ? 2 : 1;
      s = s.slice(len);
      if (ch === "\r") keys.push({ name: "enter" });
      else if (ch === "\n") keys.push({ name: "newline" });
      else if (ch === "\t") keys.push({ name: "tab" });
      else if (ch === "\x7f" || ch === "\b") keys.push({ name: "backspace" });
      else if (cp < 0x20) keys.push({ name: "char", text: String.fromCharCode(cp + 96), ctrl: true });
      else keys.push({ name: "char", text: String.fromCodePoint(cp) });
    }
    return keys;
  }

  /** A lone ESC that never got a follow-up (call after a short timeout). */
  flush(): Key[] {
    if (this.pending === "\x1b") {
      this.pending = "";
      return [{ name: "escape" }];
    }
    return [];
  }

  private escape(s: string): { key: Key; len: number } | undefined {
    if (s.length === 1) return undefined; // maybe a sequence, maybe a lone ESC
    const next = s[1]!;

    if (next === "[") {
      // CSI: ESC [ params final
      const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(s);
      if (!m) return /^\x1b\[[0-9;]*$/.test(s) ? undefined : { key: { name: "escape" }, len: 1 };
      const [all, params = "", final] = m;
      const parts = params.split(";");
      if (final === "~") {
        const name = CSI_TILDE[parts[0] ?? ""];
        return { key: name ? { name, ...mods(parts[1]) } : { name: "escape" }, len: all.length };
      }
      if (final === "u") {
        // kitty / CSI-u: ESC [ code ; mods u
        const code = Number(parts[0]);
        const mod = mods(parts[1]);
        if (code === 13) return { key: mod.shift || mod.alt || mod.ctrl ? { name: "newline" } : { name: "enter" }, len: all.length };
        if (code === 27) return { key: { name: "escape" }, len: all.length };
        if (code === 127) return { key: { name: "backspace", ...mod }, len: all.length };
        if (code === 9) return { key: { name: mod.shift ? "backtab" : "tab" }, len: all.length };
        return { key: { name: "char", text: String.fromCodePoint(code), ...mod }, len: all.length };
      }
      if (final === "Z") return { key: { name: "backtab" }, len: all.length };
      const name = CSI_FINAL[final!];
      if (name) return { key: { name, ...mods(parts[1]) }, len: all.length };
      return { key: { name: "escape" }, len: all.length }; // unknown sequence: swallow
    }

    if (next === "O" && s.length >= 3) {
      // SS3: application-mode arrows / home / end
      const name = CSI_FINAL[s[2]!];
      return { key: name ? { name } : { name: "escape" }, len: 3 };
    }
    if (next === "O") return undefined;

    // Alt + key
    if (next === "\r") return { key: { name: "newline", alt: true }, len: 2 };
    if (next === "\x7f" || next === "\b") return { key: { name: "backspace", alt: true }, len: 2 };
    if (next === "\x1b") return { key: { name: "escape" }, len: 1 };
    const cp = next.codePointAt(0)!;
    if (cp < 0x20) return { key: { name: "char", text: String.fromCharCode(cp + 96), ctrl: true, alt: true }, len: 2 };
    return { key: { name: "char", text: next, alt: true }, len: 2 };
  }
}
