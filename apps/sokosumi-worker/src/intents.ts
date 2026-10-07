// Simple intents in Task owner comments. Everything else goes to the captain as a message (DATA).
export type Intent =
  | { kind: "status" }
  | { kind: "pause"; target: string }
  | { kind: "resume"; target: string }
  | { kind: "approve"; amountTusdm: string }
  | { kind: "captain"; text: string };

export function parseIntent(comment: string): Intent {
  const t = comment.trim();
  if (/^(status\??|what'?s the status\??|status update\??)$/i.test(t)) return { kind: "status" };
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
