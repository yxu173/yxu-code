import { width } from "./text.ts";

/**
 * A small multiline text editor. Positions are in code points per line; the view maps them
 * to cells. History navigation only triggers from the first/last line so that arrow keys still
 * move the cursor inside multi-line drafts.
 */
export class Editor {
  lines: string[] = [""];
  row = 0;
  col = 0;
  private history: string[];
  private histIndex: number;
  private draft = "";

  constructor(history: string[] = []) {
    this.history = [...history];
    this.histIndex = this.history.length;
  }

  get text(): string {
    return this.lines.join("\n");
  }

  get isEmpty(): boolean {
    return this.lines.length === 1 && this.lines[0] === "";
  }

  setText(text: string) {
    this.lines = text.split("\n");
    this.row = this.lines.length - 1;
    this.col = [...this.lines[this.row]!].length;
  }

  clear() {
    this.setText("");
  }

  private get cur(): string[] {
    return [...this.lines[this.row]!];
  }

  insert(text: string) {
    const parts = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n");
    const chars = this.cur;
    const before = chars.slice(0, this.col).join("");
    const after = chars.slice(this.col).join("");
    if (parts.length === 1) {
      this.lines[this.row] = before + parts[0] + after;
      this.col += [...parts[0]!].length;
      return;
    }
    const newLines = [before + parts[0], ...parts.slice(1, -1), parts.at(-1)! + after];
    this.lines.splice(this.row, 1, ...newLines);
    this.row += parts.length - 1;
    this.col = [...parts.at(-1)!].length;
  }

  newline() {
    this.insert("\n");
  }

  backspace() {
    if (this.col > 0) {
      const chars = this.cur;
      chars.splice(this.col - 1, 1);
      this.lines[this.row] = chars.join("");
      this.col--;
    } else if (this.row > 0) {
      const prev = this.lines[this.row - 1]!;
      this.col = [...prev].length;
      this.lines.splice(this.row - 1, 2, prev + this.lines[this.row]);
      this.row--;
    }
  }

  delete() {
    const chars = this.cur;
    if (this.col < chars.length) {
      chars.splice(this.col, 1);
      this.lines[this.row] = chars.join("");
    } else if (this.row < this.lines.length - 1) {
      this.lines.splice(this.row, 2, this.lines[this.row]! + this.lines[this.row + 1]);
    }
  }

  /** Delete the word before the cursor (Ctrl+W / Alt+Backspace). */
  deleteWord() {
    if (this.col === 0) return this.backspace();
    const chars = this.cur;
    let i = this.col;
    while (i > 0 && chars[i - 1] === " ") i--;
    while (i > 0 && chars[i - 1] !== " ") i--;
    chars.splice(i, this.col - i);
    this.lines[this.row] = chars.join("");
    this.col = i;
  }

  /** Delete from the cursor to the start of the line (Ctrl+U). */
  killToStart() {
    const chars = this.cur;
    this.lines[this.row] = chars.slice(this.col).join("");
    this.col = 0;
  }

  /** Delete from the cursor to the end of the line (Ctrl+K). */
  killToEnd() {
    this.lines[this.row] = this.cur.slice(0, this.col).join("");
  }

  left() {
    if (this.col > 0) this.col--;
    else if (this.row > 0) {
      this.row--;
      this.col = this.cur.length;
    }
  }

  right() {
    if (this.col < this.cur.length) this.col++;
    else if (this.row < this.lines.length - 1) {
      this.row++;
      this.col = 0;
    }
  }

  wordLeft() {
    const chars = this.cur;
    let i = this.col;
    while (i > 0 && chars[i - 1] === " ") i--;
    while (i > 0 && chars[i - 1] !== " ") i--;
    this.col = i;
  }

  wordRight() {
    const chars = this.cur;
    let i = this.col;
    while (i < chars.length && chars[i] === " ") i++;
    while (i < chars.length && chars[i] !== " ") i++;
    this.col = i;
  }

  home() {
    this.col = 0;
  }

  end() {
    this.col = this.cur.length;
  }

  /** Up: previous line, or previous history entry when already on the first line. */
  up() {
    if (this.row > 0) {
      this.row--;
      this.col = Math.min(this.col, this.cur.length);
      return;
    }
    if (this.histIndex === 0 || !this.history.length) return;
    if (this.histIndex === this.history.length) this.draft = this.text;
    this.histIndex--;
    this.setText(this.history[this.histIndex]!);
    this.row = 0;
    this.col = Math.min(this.col, this.cur.length);
  }

  /** Down: next line, or next history entry (then the saved draft) on the last line. */
  down() {
    if (this.row < this.lines.length - 1) {
      this.row++;
      this.col = Math.min(this.col, this.cur.length);
      return;
    }
    if (this.histIndex >= this.history.length) return;
    this.histIndex++;
    this.setText(this.histIndex === this.history.length ? this.draft : this.history[this.histIndex]!);
  }

  /** Record a submitted entry and reset navigation. */
  commit(entry: string) {
    if (entry.trim() && this.history.at(-1) !== entry) this.history.push(entry);
    this.histIndex = this.history.length;
    this.draft = "";
    this.clear();
  }

  get historyEntries(): readonly string[] {
    return this.history;
  }

  /** Cursor column in cells (for placing the terminal cursor). */
  cursorCells(): number {
    return width(this.cur.slice(0, this.col).join(""));
  }
}
