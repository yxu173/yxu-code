/**
 * A remembered orchestrator conversation across turns, and the summaries made of it in the
 * background. A summary is a compacted fork of the conversation as it was after some turn; it is
 * never thrown away because the conversation moved on: the next turn resumes the summary and
 * is told what happened since (the turns after it, and the end of a run it was made during).
 * Sessions (sessions.ts) save it, so any of them can be resumed.
 */

export interface TurnRecord {
  turn: number;
  goal: string;
  finalText: string;
}

export interface Summary {
  /** The compacted fork. */
  sessionId: string;
  /** The conversation as it was after this turn. */
  afterTurn: number;
  /** What happened after the fork inside that turn (a summary made during a run). */
  tail?: string;
  preTokens?: number;
  postTokens?: number;
}

export interface ConversationState {
  /** Changes when the conversation starts over, so late summaries of an old one are ignored. */
  id: string;
  sessionId?: string;
  turn: number;
  log: TurnRecord[];
  summary?: Summary;
}

export interface NextTurn {
  resume?: string;
  /** Put before the user's message when resuming a summary the conversation has moved past. */
  preamble?: string;
  usesSummary: boolean;
}

/** How much of each earlier answer, and of everything since a summary, the next turn is told. */
const ANSWER_CHARS = 4000;
const SINCE_CHARS = 40_000;
const KEEP_TURNS = 20;

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

export class Conversation {
  state: ConversationState;

  constructor(state?: ConversationState) {
    this.state = state ?? { id: newId(), turn: 0, log: [] };
  }

  get sessionId(): string | undefined {
    return this.state.sessionId;
  }

  set sessionId(id: string | undefined) {
    this.state.sessionId = id;
  }

  get turn(): number {
    return this.state.turn;
  }

  get summary(): Summary | undefined {
    return this.state.summary;
  }

  /** Turns that ran after a summary was taken. */
  turnsSince(s: Summary): TurnRecord[] {
    return this.state.log.filter((t) => t.turn > s.afterTurn);
  }

  /** Where the next turn starts: the summary when there is one, else the conversation. */
  next(): NextTurn {
    const s = this.state.summary;
    if (!s) return { resume: this.state.sessionId, usesSummary: false };
    const since = this.turnsSince(s);
    if (!since.length && !s.tail) return { resume: s.sessionId, usesSummary: true };
    return { resume: s.sessionId, preamble: sincePreamble(s.tail, since), usesSummary: true };
  }

  /** A turn ended. With a session id, the conversation continues from it (and a summary it used is spent). */
  finish(t: { goal: string; finalText: string; sessionId?: string; usedSummary: boolean }) {
    this.state.turn += 1;
    this.state.log.push({ turn: this.state.turn, goal: t.goal, finalText: t.finalText });
    if (this.state.log.length > KEEP_TURNS) this.state.log = this.state.log.slice(-KEEP_TURNS);
    if (t.sessionId) {
      this.state.sessionId = t.sessionId;
      if (t.usedSummary) this.state.summary = undefined;
    }
  }

  /** A summary finished. Ignored if it was taken of a conversation that has since started over. */
  adopt(conversationId: string, s: Summary): boolean {
    if (conversationId !== this.state.id) return false;
    this.state.summary = s;
    return true;
  }

  /** The conversation was compacted in place (/compact): a pending summary is out of date. */
  compactedInPlace() {
    this.state.summary = undefined;
  }

  reset() {
    this.state = { id: newId(), turn: 0, log: [] };
  }
}

/**
 * The whole conversation as yxu recorded it, for when Claude's own copy can't be found: the
 * orchestrator starts a new conversation told what was said (the last turns, capped).
 */
export function recapPreamble(log: TurnRecord[]): string {
  if (!log.length) return "";
  let body = log.map((t) => `The user asked: ${clip(t.goal, ANSWER_CHARS)}\nYou answered: ${clip(t.finalText || "(no answer)", ANSWER_CHARS)}`).join("\n\n");
  if (body.length > SINCE_CHARS) body = `… (earlier turns omitted)\n${body.slice(-SINCE_CHARS)}`;
  return `[yxu] This continues an earlier conversation whose full history is no longer available. Here is what was said, as yxu recorded it (task ids in it are still valid):\n\n${body}\n\n[yxu] Now the user says:\n`;
}

/** What the orchestrator is told when it resumes a summary the conversation has moved past. */
export function sincePreamble(tail: string | undefined, since: TurnRecord[]): string {
  const parts: string[] = [];
  if (tail) parts.push(`The run that was in progress when the summary was made went on:\n${tail}`);
  for (const t of since) parts.push(`The user asked: ${clip(t.goal, ANSWER_CHARS)}\nYou answered: ${clip(t.finalText || "(no answer)", ANSWER_CHARS)}`);
  let body = parts.join("\n\n");
  // Keep the most recent part when there is too much.
  if (body.length > SINCE_CHARS) body = `… (earlier details omitted)\n${body.slice(-SINCE_CHARS)}`;
  return `[yxu] This conversation was summarized in the background, and it continued after the summary was taken. Here is what happened since, so you can pick up where it left off:\n\n${body}\n\n[yxu] Now the user says:\n`;
}
