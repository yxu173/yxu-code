export interface VerifyResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  durationMs: number;
  /** Tail of combined stdout+stderr. */
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 6_000;

/** Run a check command (tests, lint, build) in a directory. */
export async function runVerify(cwd: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<VerifyResult> {
  const started = Date.now();
  const proc = Bun.spawn(["sh", "-c", `${command} 2>&1`], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
  });
  let timedOut = false;
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // already gone
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  signal?.addEventListener("abort", kill, { once: true });

  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);
  signal?.removeEventListener("abort", kill);

  const output = out.length > MAX_OUTPUT ? `…${out.slice(-MAX_OUTPUT)}` : out;
  return { ok: exitCode === 0 && !timedOut, command, exitCode, durationMs: Date.now() - started, output: output.trim(), timedOut };
}

export function formatVerify(v: VerifyResult): string {
  const status = v.ok ? "passed" : v.timedOut ? "timed out" : `failed (exit ${v.exitCode})`;
  return `verify \`${v.command}\`: ${status} in ${(v.durationMs / 1000).toFixed(1)}s\n${v.output || "(no output)"}`;
}
