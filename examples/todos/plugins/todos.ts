/**
 * The todos plugin: a side-panel section with the repo's open TODO/FIXME comments, and commands
 * to list them and hand one to the orchestrator. An example of the yxu plugin API (v1).
 */
import type { Plugin, PluginContext } from "yxu/plugin"; // types only; erased at runtime

interface Todo {
  file: string;
  line: number;
  text: string;
}

/** TODO/FIXME comments in tracked files (git grep keeps it fast and skips ignored files). */
async function findTodos(ctx: PluginContext): Promise<Todo[]> {
  const r = await ctx.shell(`git grep -n -I -E "(TODO|FIXME)[:( ]" -- . ":(exclude).yxu"`, { timeoutMs: 10_000 });
  if (r.code > 1) throw new Error(r.stderr.trim() || "git grep failed");
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = /^(.*?):(\d+):(.*)$/.exec(l);
      return m ? { file: m[1]!, line: Number(m[2]), text: m[3]!.trim().replace(/^.*?((TODO|FIXME).*)$/, "$1") } : undefined;
    })
    .filter((t): t is Todo => Boolean(t));
}

const short = (t: Todo) => `${t.file}:${t.line}  ${t.text.slice(0, 60)}`;

export default {
  name: "todos",
  apiVersion: 1,
  description: "Open TODO/FIXME comments, and handing them to agents",

  panel: [
    {
      title: "todos",
      refresh: 30,
      async render(ctx) {
        const todos = await findTodos(ctx);
        if (!todos.length) return ["none open"];
        const fixed = ctx.data.get<number>("fixed") ?? 0;
        return [`${todos.length} open${fixed ? ` · ${fixed} handed off` : ""}`, ...todos.slice(0, 5).map(short), ...(todos.length > 5 ? [`… /todos:list for all`] : [])];
      },
    },
  ],

  commands: [
    {
      name: "list",
      description: "List every open TODO/FIXME with its number",
      async run(ctx) {
        const todos = await findTodos(ctx);
        ctx.note(todos.length ? `**Open TODOs** (fix one with /todos:fix <n>)\n${todos.map((t, i) => `${i + 1}. \`${t.file}:${t.line}\` ${t.text}`).join("\n")}` : "No open TODO or FIXME comments.");
      },
    },
    {
      name: "fix",
      usage: "[n]",
      description: "Hand TODO number n (default 1) to the orchestrator",
      async run(ctx, [n = "1"]) {
        const todos = await findTodos(ctx);
        const t = todos[Number(n) - 1];
        if (!t) throw new Error(`there is no TODO number ${n} (${todos.length} open; /todos:list)`);
        ctx.note(`Handing off \`${t.file}:${t.line}\`: ${t.text}`);
        ctx.data.set("fixed", (ctx.data.get<number>("fixed") ?? 0) + 1);
        await ctx.run(`Resolve the comment "${t.text}" at ${t.file}:${t.line}: do what it asks, then remove the comment. Keep the change small.`);
      },
    },
  ],
} satisfies Plugin;
