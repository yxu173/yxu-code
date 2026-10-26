import { describe, expect, test } from "bun:test";
import { Conversation, sincePreamble } from "../src/conversation.ts";
import { worthCompacting } from "../src/context.ts";

describe("conversation", () => {
  test("turns continue the session; a summary is resumed with what happened since, then spent", () => {
    const c = new Conversation();
    expect(c.next()).toEqual({ resume: undefined, usesSummary: false });
    c.finish({ goal: "a", finalText: "A", sessionId: "s1", usedSummary: false });
    expect(c.next()).toEqual({ resume: "s1", usesSummary: false });

    // A summary of the conversation after turn 1, ready before anything else happened.
    expect(c.adopt(c.state.id, { sessionId: "f1", afterTurn: 1 })).toBe(true);
    expect(c.next()).toEqual({ resume: "f1", usesSummary: true });

    // A turn ran on s1 before it was used: the next turn resumes f1 and hears about turn 2.
    c.finish({ goal: "b", finalText: "B", sessionId: "s1", usedSummary: false });
    const n = c.next();
    expect(n.resume).toBe("f1");
    expect(n.preamble).toContain("The user asked: b\nYou answered: B");
    expect(n.preamble).not.toContain("asked: a");
    expect(n.preamble!.endsWith("[yxu] Now the user says:\n")).toBe(true);

    // A failed turn without a session keeps the summary; a successful one spends it.
    c.finish({ goal: "c", finalText: "", usedSummary: true });
    expect(c.summary?.sessionId).toBe("f1");
    c.finish({ goal: "d", finalText: "D", sessionId: "f1-continued", usedSummary: true });
    expect(c.summary).toBeUndefined();
    expect(c.next()).toEqual({ resume: "f1-continued", usesSummary: false });
  });

  test("a summary of a conversation that started over is ignored", () => {
    const c = new Conversation();
    const old = c.state.id;
    c.reset();
    expect(c.adopt(old, { sessionId: "f", afterTurn: 0 })).toBe(false);
    expect(c.summary).toBeUndefined();
  });

  test("what the orchestrator is told is capped, keeping the most recent part", () => {
    const p = sincePreamble("x".repeat(60_000), [{ turn: 2, goal: "g", finalText: "y".repeat(30_000) }]);
    expect(p.length).toBeLessThan(42_000);
    expect(p).toContain("(earlier details omitted)");
    expect(p).toContain("You answered: yyyy");
  });

  test("a summary is only worth making when the conversation itself is a real part of the window", () => {
    const u = (pct: number, messages: number) => ({ tokens: pct * 1000, max: 100_000, percentage: pct, autoCompact: true, categories: [{ name: "Messages", tokens: messages, kind: "used" }] });
    const k = { background_at: 0.6 };
    expect(worthCompacting(u(50, 40_000), k)).toBe(false); // below the threshold
    expect(worthCompacting(u(70, 50_000), k)).toBe(true);
    expect(worthCompacting(u(70, 3_000), k)).toBe(false); // mostly system prompt and tools: a summary can't help
    expect(worthCompacting({ ...u(70, 0), categories: [] }, k)).toBe(true); // no breakdown: trust the total
    expect(worthCompacting(undefined, k)).toBe(false);
  });
});
