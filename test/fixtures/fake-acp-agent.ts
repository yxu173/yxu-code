// A tiny ACP agent for tests. Behavior comes from the prompt text:
//   WRITE <file> <word>   edit: write the file (in its cwd)
//   RUN <command>         execute: ask permission, then append the command to ran.txt if allowed
//   SLOW                  wait 10 s (for cancel/timeout tests)
// Models offered: fake/small, fake/big. FAKE_ACP_AUTH=1 makes session/new fail with auth_required.
import { appendFileSync, writeFileSync } from "node:fs";

const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
let model = "fake/small";
let nextId = 1000;
const waiting = new Map<number, (r: any) => void>();
const ask = (method: string, params: unknown) =>
  new Promise<any>((res) => {
    const id = nextId++;
    waiting.set(id, res);
    send({ jsonrpc: "2.0", id, method, params });
  });
const update = (sessionId: string, u: unknown) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

let buf = "";
process.stdin.on("data", async (chunk) => {
  buf += chunk.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && !m.method) {
      waiting.get(m.id)?.(m.result);
      continue;
    }
    handle(m);
  }
});

async function handle(m: any) {
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "x", name: "Login", description: "run `fake login`" }] });
    case "session/new":
      if (process.env.FAKE_ACP_AUTH === "1") return fail(-32000, "Authentication required");
      return reply({
        sessionId: "s1",
        configOptions: [{ id: "model", category: "model", type: "select", currentValue: model, options: [{ value: "fake/small", name: "Small" }, { value: "fake/big", name: "Big" }] }],
      });
    case "session/set_config_option":
      model = m.params.value;
      return reply({});
    case "session/prompt": {
      const text: string = m.params.prompt.map((p: any) => p.text).join("\n");
      const sid = m.params.sessionId;
      if (text.includes("SLOW")) await new Promise((r) => setTimeout(r, 10_000));
      for (const [, f, w] of text.matchAll(/WRITE (\S+) (\S+)/g)) {
        update(sid, { sessionUpdate: "tool_call", toolCallId: `w-${f}`, title: "edit", kind: "edit", status: "pending", rawInput: {} });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: `w-${f}`, status: "in_progress", kind: "edit", locations: [{ path: f }], rawInput: { filePath: f } });
        writeFileSync(f!, `${w}\n`);
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: `w-${f}`, status: "completed" });
      }
      for (const [, cmd] of text.matchAll(/RUN (.+)/g)) {
        const toolCall = { toolCallId: `r-${cmd}`, title: "bash", kind: "execute", rawInput: { command: cmd } };
        update(sid, { sessionUpdate: "tool_call", ...toolCall, status: "pending" });
        const r = await ask("session/request_permission", {
          sessionId: sid,
          toolCall,
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        });
        const allowed = r?.outcome?.outcome === "selected" && r.outcome.optionId !== "no";
        if (allowed) appendFileSync("ran.txt", `${cmd}\n`);
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: allowed ? "completed" : "failed" });
      }
      update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: `done with ${model}` } });
      update(sid, { sessionUpdate: "usage_update", used: 100, size: 1000, cost: { amount: 0.25, currency: "USD" } });
      return reply({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2 } });
    }
    default:
      if (m.id !== undefined) fail(-32601, "nope");
  }
}
