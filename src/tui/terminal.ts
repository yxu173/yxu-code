import type { Frame } from "./view.ts";

const ESC = "\x1b[";

/**
 * Owns the real terminal: alternate screen, raw input, resize events, and efficient redraws
 * (only rows that changed are rewritten). Always restores the terminal, even on crashes.
 */
export class Terminal {
  private prev: string[] = [];
  private active = false;
  private onData?: (chunk: string) => void;
  private onResize?: () => void;
  private readonly restoreBound = () => this.stop();

  constructor(
    private readonly out: NodeJS.WriteStream = process.stdout,
    private readonly inp: NodeJS.ReadStream = process.stdin,
  ) {}

  get size(): { width: number; height: number } {
    return { width: this.out.columns || 80, height: this.out.rows || 24 };
  }

  /** Mouse wheel reporting (SGR); without it the wheel arrives as ↑/↓ and would page through history. */
  private mouse = true;

  start(handlers: { data: (chunk: string) => void; resize: () => void }, opts: { mouse?: boolean } = {}) {
    if (this.active) return;
    this.active = true;
    this.mouse = opts.mouse ?? true;
    this.onData = handlers.data;
    this.onResize = () => {
      this.prev = []; // full repaint after a resize
      handlers.resize();
    };
    // Alternate screen, hide cursor, bracketed paste, no line wrap at the right edge.
    this.write(`${ESC}?1049h${ESC}?25l${ESC}?2004h${ESC}?7l${ESC}2J${ESC}H`);
    // Wheel events as mouse reports (1000 + SGR 1006). With the mouse off, at least stop the
    // terminal from turning the wheel into arrow keys in the alternate screen (1007).
    this.write(this.mouse ? `${ESC}?1000h${ESC}?1006h` : `${ESC}?1007l`);
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.setEncoding("utf8");
    this.inp.on("data", this.onData);
    this.inp.resume();
    this.out.on("resize", this.onResize);
    process.on("exit", this.restoreBound);
    process.on("uncaughtException", this.crash);
    process.on("unhandledRejection", this.crash);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    if (this.onData) this.inp.off("data", this.onData);
    if (this.onResize) this.out.off("resize", this.onResize);
    if (this.inp.isTTY) this.inp.setRawMode(false);
    this.inp.pause();
    this.write(this.mouse ? `${ESC}?1006l${ESC}?1000l` : `${ESC}?1007h`);
    this.write(`${ESC}0m${ESC}?7h${ESC}?2004l${ESC}?25h${ESC}?1049l`);
    process.off("exit", this.restoreBound);
    process.off("uncaughtException", this.crash);
    process.off("unhandledRejection", this.crash);
  }

  private crash = (err: unknown) => {
    this.stop();
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  };

  /** Force the next draw to repaint everything (Ctrl+L). */
  invalidate() {
    this.prev = [];
    this.write(`${ESC}2J`);
  }

  draw(frame: Frame) {
    if (!this.active) return;
    let buf = `${ESC}?25l`;
    frame.rows.forEach((row, i) => {
      // Rows are already padded to full width; erase-to-EOL here would clear the last cell.
      if (this.prev[i] !== row) buf += `${ESC}${i + 1};1H${row}${ESC}0m`;
    });
    for (let i = frame.rows.length; i < this.prev.length; i++) buf += `${ESC}${i + 1};1H${ESC}0m${ESC}K`;
    this.prev = frame.rows;
    if (frame.cursor) buf += `${ESC}${frame.cursor.row + 1};${frame.cursor.col + 1}H${ESC}?25h`;
    this.write(buf);
  }

  private write(s: string) {
    this.out.write(s);
  }
}
