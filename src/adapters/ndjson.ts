/** Parse NDJSON, skipping blank or non-JSON lines (CLIs sometimes print banners). */
export function ndjson(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // partial or garbled line; ignore
    }
  }
  return out;
}

/** Last non-empty stderr line, used as a fallback error message. */
export function lastLine(text: string): string | undefined {
  return text.trim().split("\n").filter(Boolean).at(-1);
}
