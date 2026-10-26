/**
 * Runtime and platform helpers. Every Bun-specific API (spawn, which, stringWidth) is used
 * only here, so a Node port or a native Windows port touches one file (docs/PUBLIC_PLAN.md §8).
 *
 * Windows: commands are resolved through PATH/PATHEXT first (so npm's .cmd shims run), shell
 * command lines use Git's `sh` when it is installed (packs and docs write POSIX commands) and
 * cmd.exe otherwise, and process trees are ended with `taskkill /T` instead of process groups.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

export const isWindows = process.platform === "win32";

/** Absolute path of an executable on PATH, or null. */
export function which(bin: string): string | null {
  // The current PATH, explicitly: on Windows Bun otherwise keeps using the one it started with.
  return Bun.which(bin, { PATH: process.env.PATH ?? process.env.Path ?? "" });
}

/** Git for Windows' sh, if installed (PATH first, then the usual install folders). */
function windowsSh(): string | null {
  const found = which("sh");
  if (found) return found;
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Programs`]) {
    const p = base && `${base}\\Git\\bin\\sh.exe`;
    if (p && existsSync(p)) return p;
  }
  return null;
}

/** argv that runs a shell command line: `sh -c` (on Windows Git's sh, else cmd.exe). */
export function shellArgv(command: string): string[] {
  if (!isWindows) return ["sh", "-c", command];
  const sh = windowsSh();
  return sh ? [sh, "-c", command] : ["cmd.exe", "/d", "/s", "/c", command];
}

/** Like shellArgv, with stderr folded into stdout for the whole command list. */
export function shellArgvMerged(command: string): string[] {
  const argv = shellArgv(command);
  return argv[0] === "cmd.exe" ? [...argv.slice(0, -1), `(${command}) 2>&1`] : [argv[0]!, "-c", `(${command}\n) 2>&1`];
}

/**
 * On Windows, run `foo` as the file PATHEXT finds, as a Unix shell would. npm installs CLIs as
 * `.cmd` shims, and cmd.exe can't pass arguments with newlines (every agent prompt has them), so
 * a shim is run as the script it points to (`node <script>`, or the .exe directly).
 */
export function resolveArgv(argv: string[]): string[] {
  if (!isWindows || !argv[0]) return argv;
  const exe = /[\\/]/.test(argv[0]) ? argv[0] : which(argv[0]);
  if (!exe) return argv;
  const rest = argv.slice(1);
  if (!/\.(cmd|bat)$/i.test(exe)) return [exe, ...rest];
  const target = npmShimTarget(readFileSync(exe, "utf8"), exe);
  if (target) {
    if (/\.exe$/i.test(target)) return [target, ...rest];
    const local = join(dirname(exe), "node.exe");
    return [existsSync(local) ? local : (which("node") ?? "node"), target, ...rest];
  }
  // Not an npm shim: cmd.exe it is (arguments with newlines or quotes may not survive).
  return ["cmd.exe", "/d", "/s", "/c", exe, ...rest];
}

/** The script an npm `.cmd` shim runs: `"%dp0%\node_modules\x\bin\x.js" %*` (or `%~dp0`). */
export function npmShimTarget(text: string, shimFile: string): string | undefined {
  const m = /"%~?dp0%?\\([^"]+)"\s+%\*/i.exec(text);
  return m ? join(dirname(shimFile), ...m[1]!.split("\\")) : undefined;
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
  /** Called with stdout as it arrives (the full text is still in the result). */
  onStdout?: (chunk: string) => void;
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
  const p = Bun.spawnSync(resolveArgv(argv), { cwd: opts.cwd, env: envFor(opts), stdout: "pipe", stderr: "pipe" });
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
  const proc = Bun.spawn(resolveArgv(argv), {
    cwd: opts.cwd,
    env: envFor(opts),
    detached: opts.detached,
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = opts.onStdout ? streamText(proc.stdout, opts.onStdout) : new Response(proc.stdout).text();
  const result = Promise.all([out, new Response(proc.stderr).text()]).then(async ([stdout, stderr]) => ({ code: await proc.exited, stdout, stderr }));
  return { pid: proc.pid, result, kill: (signal) => proc.kill(signal) };
}

async function streamText(stream: ReadableStream<Uint8Array>, on: (chunk: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  let all = "";
  for await (const bytes of stream) {
    const chunk = decoder.decode(bytes, { stream: true });
    all += chunk;
    try {
      on(chunk);
    } catch {
      // a viewer's problem never stops the agent
    }
  }
  return all + decoder.decode();
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
  const proc = Bun.spawn(resolveArgv(argv), { cwd: opts.cwd, env: envFor(opts), detached: opts.detached, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
  const proc = Bun.spawn(resolveArgv(argv), { cwd: opts.cwd, env: envFor(opts), stdio: [opts.stdin ?? "inherit", "inherit", "inherit"] });
  return proc.exited;
}

/** End a process and everything it started: its process group on Unix, its tree on Windows. */
/** Pause or continue a process group (Unix). Returns false where it can't (Windows). */
export function signalGroup(pid: number, signal: "SIGSTOP" | "SIGCONT"): boolean {
  if (isWindows) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function killGroup(pid: number, signal: NodeJS.Signals) {
  if (isWindows) {
    // Console programs ignore taskkill's polite close, so the tree is always ended forcibly.
    Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    return;
  }
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
