/**
 * Repository trust. A repo's own config (yxu.yaml, yxu.local.yaml, .yxu/…) can name commands to
 * run: hooks, verify and shell steps, agent commands, shell slash commands, and `yolo` agents.
 * Cloning a repo must not be enough to run them, so yxu runs them only after you trust that
 * repo once (`yxu trust`, or /trust), like an editor's workspace trust. Your own files in
 * ~/.config/yxu are always trusted. CI can set YXU_TRUST=1.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { userConfigDir } from "./config-layers.ts";

const file = () => join(userConfigDir(), "trust.json");
type TrustFile = { repos: Record<string, { trustedAt: string }> };

function read(): TrustFile {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as TrustFile) : { repos: {} };
  } catch {
    return { repos: {} };
  }
}

const key = (root: string) => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};

export function isTrusted(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.YXU_TRUST === "1") return true;
  return key(root) in read().repos;
}

export function setTrust(root: string, trusted: boolean) {
  const t = read();
  if (trusted) t.repos[key(root)] = { trustedAt: new Date().toISOString() };
  else delete t.repos[key(root)];
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(t, null, 2)}\n`);
}

export function trustedRepos(): string[] {
  return Object.keys(read().repos).sort();
}

export class TrustError extends Error {}

const REPO_LAYERS = new Set(["project", "local"]);

/** True when `key` (or the closest parent that has an origin) came from the repo's own files. */
function fromRepo(cfg: Config, k: string): boolean {
  const origins = cfg.origins;
  if (!origins) return false; // a config not loaded from layers (tests, embedding)
  const parts = k.split(".");
  for (let i = parts.length; i > 0; i--) {
    const o = origins[parts.slice(0, i).join(".")];
    if (o) return REPO_LAYERS.has(o);
  }
  // A section: is anything under it from the repo?
  return Object.entries(origins).some(([ok, layer]) => ok.startsWith(`${k}.`) && REPO_LAYERS.has(layer));
}

/** Throw unless the repo is trusted or `key` didn't come from the repo's own config. */
export function guard(cfg: Config, k: string, what: string) {
  if (cfg.trusted !== false || !fromRepo(cfg, k)) return;
  throw new TrustError(
    `This repository's config wants to run ${what}. yxu only runs commands from a repo's own config after you trust it: run \`yxu trust\` (or /trust in the interface) if you trust this repo.`,
  );
}

/** Whether an agent's yolo permission came from an untrusted repo (it then runs as accept-edits). */
export function untrustedYolo(cfg: Config, agent: string): boolean {
  return cfg.trusted === false && cfg.agents[agent]?.permission === "yolo" && fromRepo(cfg, `agents.${agent}.permission`);
}

/** Everything in the repo's config that waits for trust, for one clear message up front. */
export function needsTrust(cfg: Config): string[] {
  if (cfg.trusted !== false) return [];
  const out: string[] = [];
  for (const [event, cmds] of Object.entries(cfg.hooks ?? {})) if (cmds?.length && fromRepo(cfg, `hooks.${event}`)) out.push(`${event} hooks`);
  if (cfg.settings.verify && fromRepo(cfg, "settings.verify")) out.push(`verify command \`${cfg.settings.verify}\``);
  for (const [name, a] of Object.entries(cfg.agents)) {
    if (a.command && fromRepo(cfg, `agents.${name}.command`)) out.push(`agent ${name}'s command \`${a.command.join(" ")}\``);
    if (a.permission === "yolo" && fromRepo(cfg, `agents.${name}.permission`)) out.push(`yolo permission for ${name} (runs as accept-edits until trusted)`);
  }
  for (const [name, wf] of Object.entries(cfg.workflows)) {
    const steps = (wf.steps ?? []).flatMap(function flat(s): typeof wf.steps & {} {
      return s.type === "parallel" || s.type === "loop" ? [s, ...s.steps.flatMap(flat)] : [s];
    });
    const runs = steps.filter((s) => s.type === "shell" || (s.type === "verify" && s.command)).length;
    if (runs && fromRepo(cfg, `workflows.${name}`)) out.push(`workflow ${name} (${runs} command step${runs === 1 ? "" : "s"})`);
  }
  return out;
}
