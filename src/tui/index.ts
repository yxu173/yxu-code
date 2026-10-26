import type { Config } from "../config.ts";
import { App, productionEngine } from "./app.ts";
import { demoBackend, demoEngine } from "./demo.ts";
import { Terminal } from "./terminal.ts";
import { createTheme, type ThemeOptions } from "./theme.ts";

import type { SessionFile } from "../sessions.ts";

export interface TuiOptions extends ThemeOptions {
  cfg: Config;
  root: string;
  workflow?: string;
  /** Development only: scripted engine, no agents, no git. */
  demo?: boolean;
  /** --set overrides the config was loaded with (shown by /config). */
  sets?: string[];
  /** A saved session to continue. */
  resume?: SessionFile;
  /** Where yxu was started (recorded with the session). */
  folder?: string;
}

/** Launch the interactive interface. Resolves with the results still waiting for a decision. */
export function runTui(opts: TuiOptions): Promise<{ pending: { taskId: string; agent: string }[] }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error("yxu tui needs an interactive terminal (use `yxu run` for scripts)"));
  }
  const theme = createTheme(opts);
  const term = new Terminal();
  return new Promise((resolve) => {
    let app: App;
    app = new App({
      cfg: opts.cfg,
      root: opts.root,
      theme,
      workflow: opts.workflow,
      demo: opts.demo,
      sets: opts.sets,
      resume: opts.resume,
      folder: opts.folder,
      engine: opts.demo ? demoEngine() : productionEngine(opts.root),
      backend: opts.demo ? demoBackend(() => app.taskSession) : undefined,
      historyFile: opts.demo ? null : undefined,
      draw: (f) => term.draw(f),
      size: () => term.size,
      invalidate: () => term.invalidate(),
      exit: (summary) => {
        term.stop();
        resolve(summary);
      },
    });
    term.start({ data: (c) => app.input(c), resize: () => app.render() }, { mouse: opts.cfg.ui.mouse });
    if (!opts.demo) app.prefetchModels();
    process.on("SIGTERM", () => app.quit());
    app.render();
  });
}
