/** `yxu plugins [list|approve [name...]|revoke <name>]`. */
import { parseArgs } from "node:util";
import { display, loadLayers } from "./config-layers.ts";
import { repoRoot } from "./git.ts";
import { loadPlugins, setApproval, type PluginEntry } from "./plugins.ts";

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);

export function describeEntry(e: PluginEntry): string {
  const p = e.plugin;
  if (!p) return "";
  return [
    p.commands?.length && `commands ${p.commands.map((c) => `/${p.name}:${c.name}`).join(" ")}`,
    p.panel?.length && `panel ${p.panel.map((x) => x.title).join(", ")}`,
    p.hooks && `hooks ${Object.keys(p.hooks).join(", ")}`,
    p.agents?.length && `agents ${p.agents.map((a) => a.cli).join(", ")}`,
    p.orchestrators?.length && `orchestrators ${p.orchestrators.map((o) => o.name).join(", ")}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function pluginsCommand(argv: string[]): number {
  const [sub = "list", ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean" } } });
  const root = repoRoot(process.cwd());
  const reg = loadPlugins(root);
  switch (sub) {
    case "list":
    case "ls": {
      if (values.json) {
        console.log(JSON.stringify(reg.entries.map(({ plugin, ...e }) => ({ ...e, name: plugin?.name, adds: describeEntry({ ...e, plugin }) })), null, 2));
        return 0;
      }
      if (!reg.entries.length) {
        console.log("no plugins; put one in .yxu/plugins/ (team) or ~/.config/yxu/plugins/ (you), or install a pack with one (docs/PLUGINS.md)");
        return 0;
      }
      for (const e of reg.entries) {
        const mark = e.status === "loaded" ? "✓" : e.status === "error" ? "✗" : "!";
        const state = { loaded: "", pending: "waits for approval: yxu plugins approve", changed: "changed since you approved it: yxu plugins approve", error: e.error ?? "error" }[e.status];
        console.log(`${mark} ${(e.plugin?.name ?? e.id).padEnd(14)} ${dim(`${e.scope}${e.pack ? ` · pack ${e.pack}` : ""} · ${display(e.path, root)}`)}${state ? `  ${state}` : ""}`);
        const adds = describeEntry(e);
        if (adds) console.log(dim(`  ${adds}`));
      }
      return reg.entries.some((e) => e.status !== "loaded") ? 1 : 0;
    }
    case "approve": {
      const waiting = reg.entries.filter((e) => (e.status === "pending" || e.status === "changed") && (!positionals.length || positionals.includes(e.id)));
      if (!waiting.length) {
        console.log(positionals.length ? `no plugin named ${positionals.join(", ")} waits for approval` : "no plugins wait for approval");
        return positionals.length ? 1 : 0;
      }
      for (const e of waiting) {
        setApproval(e.path, true);
        console.log(`✓ approved ${e.id} (${display(e.path, root)}) at its current code`);
      }
      const after = loadPlugins(root).entries.filter((e) => waiting.some((w) => w.path === e.path));
      for (const e of after) if (e.status === "error") console.log(`✗ ${e.id}: ${e.error}`);
      loadLayers(root); // check the config with the plugins in place
      return after.some((e) => e.status === "error") ? 1 : 0;
    }
    case "revoke": {
      const e = reg.entries.find((x) => x.scope === "project" && (positionals.includes(x.id) || positionals.includes(x.plugin?.name ?? "")));
      if (!e) throw new Error("usage: yxu plugins revoke <name> (a plugin from this repo or its packs)");
      setApproval(e.path, false);
      console.log(`✓ ${e.id} is no longer approved; it won't load`);
      return 0;
    }
    default:
      throw new Error("usage: yxu plugins [list|approve [name...]|revoke <name>]");
  }
}
