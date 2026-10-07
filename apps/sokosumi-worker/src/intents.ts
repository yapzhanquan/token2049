// Simple intents in Task owner comments. Everything else goes to the captain as a message (DATA).
export type Intent =
  | { kind: "status" }
  | { kind: "pause"; target: string }
  | { kind: "resume"; target: string }
  | { kind: "approve"; amountTusdm: string }
  /** A short approval / go-ahead with no instruction in it ("approve", "auto approve", "go", "ok"): answered with
   * the current status and what (if anything) needs the owner, not forwarded to the captain. */
  | { kind: "nudge"; word: string }
  | { kind: "captain"; text: string };

export function parseIntent(comment: string): Intent {
  const t = comment.trim();
  if (/^(status\??|what'?s the status\??|status update\??|\?+|any updates?\??|update\??)$/i.test(t)) return { kind: "status" };
  const nudge = /^(?:please\s+)?((?:auto[- ]?)?approve[ds]?|approve (?:it|all|everything)|yes|yep|ok(?:ay)?|go(?: ahead)?|go go|continue|proceed|start|run it|do it|lgtm)(?:\s+please)?[\s.!]*$/i.exec(t);
  if (nudge) return { kind: "nudge", word: nudge[1].toLowerCase() };
  let m = /^pause\s+(?:session\s+)?([A-Za-z][\w -]{0,60})$/i.exec(t);
  if (m) return { kind: "pause", target: m[1].trim() };
  m = /^resume\s+(?:session\s+)?([A-Za-z][\w -]{0,60})$/i.exec(t);
  if (m) return { kind: "resume", target: m[1].trim() };
  m = /^approve\s+(\d{1,6}(?:\.\d{1,6})?)\s*t?usdm?$/i.exec(t);
  if (m) return { kind: "approve", amountTusdm: m[1] };
  return { kind: "captain", text: t.slice(0, 4000) };
}

/** Match a pause/resume target against sessions by letter ("B") or role ("researcher"). */
export function matchSession<T extends { letter?: string; role?: string }>(target: string, sessions: T[]): T[] {
  const t = target.trim().toLowerCase();
  const byLetter = sessions.filter((s) => s.letter?.toLowerCase() === t);
  if (byLetter.length) return byLetter;
  const exact = sessions.filter((s) => s.role?.toLowerCase() === t);
  if (exact.length) return exact;
  return sessions.filter((s) => !!s.role && s.role.toLowerCase().includes(t));
}
