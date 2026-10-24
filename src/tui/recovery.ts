/** Map a failure message to one concrete next step. Unknown failures get a generic, honest hint. */
export function recoveryHint(message: string): string {
  const m = message.toLowerCase();
  if (/usage limit|rate limit|429|quota|overloaded/.test(m)) {
    return "an agent or the orchestrator is rate-limited: retry later, or switch the agent in yxu.yaml (yxu agents)";
  }
  if (/budget/.test(m)) return "the orchestrator budget ran out: raise orchestrator.max_budget_usd in yxu.yaml, or send a smaller goal";
  if (/auth|login|unauthori[sz]ed|401|403|api key|credential/.test(m)) return "an agent CLI is not logged in: run yxu doctor, then log in to that CLI";
  if (/not found on path|enoent|command not found/.test(m)) return "an agent CLI is missing: run yxu doctor to see which";
  if (/timed? ?out|timeout/.test(m)) return "something took too long: raise the agent's timeout in yxu.yaml, or split the goal";
  if (/conflict/.test(m)) return "resolve or rebase your branch, or ask yxu to redo the work on top of your current HEAD";
  if (/uncommitted changes/.test(m)) return "commit or stash your changes, then apply again";
  if (/still failing|verify/.test(m)) return "the checks did not pass: review the verify output above, then ask for a targeted fix";
  if (/not a git repository/.test(m)) return "run yxu inside a git repository";
  return "your branch is untouched. Review the activity above (ctrl+o for details), then send again or rephrase";
}
