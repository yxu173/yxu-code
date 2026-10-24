/**
 * Runtime and platform helpers. Every Bun-specific API (spawn, which, stringWidth) is used
 * only here, so a Node port or a native Windows port touches one file (docs/PUBLIC_PLAN.md §8).
 */
import { existsSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

/** Absolute path of an executable on PATH, or null. */
export function which(bin: string): string | null {
  return Bun.which(bin);
}

/** Display width of a string in terminal cells. */
export function stringWidth(s: string): number {
  return Bun.stringWidth(s);
}

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Start in a new process group so killGroup() reaches everything it spawns. */
  detached?: boolean;
  /** Text written to the child's stdin (otherwise stdin is closed). */
  stdin?: string;
}

/**
 * The child's environment. PWD must match the working directory: some CLIs trust $PWD over
 * their real cwd, and would otherwise work in the directory yxu was started from.
 */
function envFor(opts: SpawnOptions): Record<string, string | undefined> | undefined {
  return opts.cwd ? { ...(opts.env ?? process.env), PWD: opts.cwd } : opts.env;
}

/** Run a command to completion, capturing output. Throws if the executable can't start. */
export function runSync(argv: string[], opts: SpawnOptions = {}): Captured {
  const p = Bun.spawnSync(argv, { cwd: opts.cwd, env: envFor(opts), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

export interface Child {
  pid: number;
  /** Resolves once the process exits and both streams are drained. */
  result: Promise<Captured>;
  kill(signal?: NodeJS.Signals): void;
}

/** Start a command with stdin closed and stdout/stderr captured. */
export function start(argv: string[], opts: SpawnOptions = {}): Child {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: envFor(opts),
    detached: opts.detached,
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
    async ([stdout, stderr]) => ({ code: await proc.exited, stdout, stderr }),
  );
  return { pid: proc.pid, result, kill: (signal) => proc.kill(signal) };
}

export interface Duplex {
  pid: number;
  write(text: string): void;
  /** Lines from stdout, as they arrive. */
  lines(): AsyncGenerator<string>;
  /** stderr, complete once the process exits. */
  stderr: Promise<string>;
  exited: Promise<number>;
}

/** Start a long-running process we talk to over stdin/stdout (e.g. an ACP agent). */
export function spawnDuplex(argv: string[], opts: SpawnOptions = {}): Duplex {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: envFor(opts), detached: opts.detached, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(proc.stderr).text();
  return {
    pid: proc.pid,
    write(text) {
      try {
        proc.stdin.write(text);
        proc.stdin.flush();
      } catch {
        // the process is gone; the reader will notice
      }
    },
    async *lines() {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          yield buf.slice(0, nl);
          buf = buf.slice(nl + 1);
        }
      }
      if (buf) yield buf;
    },
    stderr,
    exited: proc.exited,
  };
}

/** Run a command attached to this terminal; resolves with its exit code. */
export async function runAttached(argv: string[], opts: SpawnOptions & { stdin?: "inherit" | "ignore" } = {}): Promise<number> {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: envFor(opts), stdio: [opts.stdin ?? "inherit", "inherit", "inherit"] });
  return proc.exited;
}

/** Signal a whole process group started with `detached: true` (Unix). */
export function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

/** True when running as a `bun build --compile` single-file binary. */
export function isCompiled(): boolean {
  return import.meta.url.includes("$bunfs") || /[\\/]~BUN[\\/]/.test(import.meta.url);
}

/**
 * The Claude Code executable the orchestrator should drive.
 * From source, the Agent SDK finds its own bundled engine (undefined = let it decide).
 * A compiled yxu binary can't reach that engine inside its virtual filesystem, so it uses
 * $YXU_CLAUDE_PATH or the `claude` on PATH, which the user has installed and logged in anyway.
 */
export function claudeExecutable(): string | undefined {
  const override = process.env.YXU_CLAUDE_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`YXU_CLAUDE_PATH points to a missing file: ${override}`);
    return override;
  }
  if (!isCompiled()) return undefined;
  const found = which("claude");
  if (!found) throw new Error("Claude Code (`claude`) not found on PATH — install it from https://claude.com/claude-code and log in, or set YXU_CLAUDE_PATH");
  return found;
}
