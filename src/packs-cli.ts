/** `yxu add <source>` and `yxu packs [list|update|remove|install]`. */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { display } from "./config-layers.ts";
import { repoRoot } from "./git.ts";
import { addPack, describePack, packStatus, removePack, restorePacks, updatePacks, type PackIO } from "./pack-install.ts";
import { lockPath, readManifest, type PackScope } from "./packs.ts";
import { builtinPackNames, fetchSource, parseSource } from "./sources.ts";
import { isTrusted } from "./trust.ts";

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);

export async function yesNo(question: string, def = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    return a ? a.startsWith("y") : def;
  } finally {
    rl.close();
  }
}

function io(yes: boolean | undefined, builtin: boolean): PackIO {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  return {
    print: (l) => console.log(l),
    dim,
    confirm: async (lines, runs) => {
      for (const l of lines) console.log(l);
      if (runs.length) console.log(`  can run   ${runs.join("\n            ")}`);
      if (yes || builtin || !runs.length) return true;
      if (!interactive) throw new Error("this pack runs commands; pass --yes to install it without a prompt");
      return yesNo("\nInstall it?");
    },
  };
}

function starterList(): string {
  const rows = builtinPackNames().map((n) => {
    const got = fetchSource(parseSource(n));
    try {
      const m = readManifest(got.path);
      return `  ${n.padEnd(8)} ${dim(m.description ?? "")}`;
    } finally {
      got.cleanup();
    }
  });
  return `starter packs (built in):\n${rows.join("\n")}`;
}

export async function addCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { user: { type: "boolean" }, as: { type: "string" }, yes: { type: "boolean", short: "y" } },
  });
  if (!positionals.length) {
    console.log(`usage: yxu add <source> [--user] [--as name] [--yes]\n\n${starterList()}\n\nother sources: github:owner/repo[/path][@ref], a git URL, or ./folder`);
    return 0;
  }
  const root = repoRoot(process.cwd());
  const scope: PackScope = values.user ? "user" : "project";
  for (const spec of positionals) {
    const builtin = parseSource(spec).kind === "builtin";
    const pack = await addPack(root, spec, { scope, as: values.as }, io(values.yes, builtin));
    if (!pack) continue;
    console.log(`✓ added ${pack.name}${pack.manifest.version ? ` ${pack.manifest.version}` : ""} → ${display(pack.dir, root)}`);
    if (scope === "project" && !isTrusted(root) && describePack(pack, "", "").runs.length) {
      console.log(dim(`  this repo isn't trusted yet, so the pack's commands wait for \`yxu trust\``));
    }
    if (scope === "project") console.log(dim(`  commit .yxu/packs/${pack.name} and yxu.lock so your team gets the same setup`));
  }
  return 0;
}

export async function packsCommand(argv: string[]): Promise<number> {
  const [sub = "list", ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { user: { type: "boolean" }, project: { type: "boolean" }, verbose: { type: "boolean", short: "v" }, extends: { type: "boolean" }, json: { type: "boolean" } },
  });
  const root = repoRoot(process.cwd());
  const scope: PackScope | undefined = values.user ? "user" : values.project ? "project" : undefined;
  const out: PackIO = { print: (l) => console.log(l), dim };
  switch (sub) {
    case "list":
    case "ls": {
      const rows = packStatus(root);
      if (values.json) {
        console.log(JSON.stringify(rows.map(({ pack: _p, ...r }) => r), null, 2));
        return 0;
      }
      if (!rows.length) {
        console.log(`no packs installed\n\n${starterList()}\n\nadd one: yxu add <name|github:owner/repo|./folder>`);
        return 0;
      }
      for (const r of rows) {
        const mark = r.state === "ok" ? "✓" : r.state === "missing" ? "✗" : "!";
        const note = { ok: "", modified: "  files changed since yxu.lock (edited by hand?)", missing: "  in yxu.lock but not installed: yxu packs install", unlocked: "  not in yxu.lock" }[r.state];
        console.log(`${mark} ${r.name.padEnd(14)} ${(r.version ?? "").padEnd(8)} ${dim(`${r.scope} · ${r.source ?? "?"}${r.commit ? ` @ ${r.commit.slice(0, 10)}` : ""}`)}${note}`);
        if (values.verbose && r.pack) {
          const { lines, runs } = describePack(r.pack, r.source ?? "?", display(r.pack.dir, root));
          for (const l of lines.slice(1)) console.log(dim(l));
          if (runs.length) console.log(dim(`  can run   ${runs.join("\n            ")}`));
        }
      }
      return rows.some((r) => r.state !== "ok") ? 1 : 0;
    }
    case "update":
    case "up":
      updatePacks(root, positionals, out, { scope, extends: values.extends });
      return 0;
    case "remove":
    case "rm":
      if (!positionals.length) throw new Error("usage: yxu packs remove <name>... [--user]");
      for (const n of positionals) removePack(root, n, out, scope);
      return 0;
    case "install": {
      const n = restorePacks(root, out);
      console.log(n ? `✓ installed ${n} pack${n === 1 ? "" : "s"} from yxu.lock` : `✓ every pack in ${display(lockPath("project", root), root)} is installed`);
      return 0;
    }
    default:
      throw new Error("usage: yxu packs [list [-v]|update [name...] [--extends]|remove <name>|install] [--user]");
  }
}
