"use client";
// Chat with the captain (POST /captain/messages) + the captain log: woken vs absorbed counts,
// tool actions and reports. The captain only wakes for actionable events; routine progress is absorbed.
import { useEffect, useRef, useState } from "react";
import type { CaptainLogDTO } from "@bulkhead/shared";
import { api, isTransient, useLive, useResource } from "@/lib/client";
import { Reconnecting } from "./IdChip";
import { timeOf } from "@/lib/money";

export function CaptainPanel({ goalId, onSelectSession }: { goalId: string | null; onSelectSession: (id: string) => void }) {
  const { data: log, reconnecting, reload } = useResource<CaptainLogDTO>("/captain/log");
  const { bump } = useLive();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showAbsorbed, setShowAbsorbed] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  const entries = log?.entries ?? [];
  const chat = entries.filter((e) => e.kind === "user_message" || e.kind === "report");
  const logEntries = entries.filter((e) => e.kind !== "user_message" && e.kind !== "report" && (showAbsorbed || e.kind !== "absorbed")).slice(-80).reverse();

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [chat.length]);

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/captain/messages", { body: { text: text.trim(), goalId } });
      setText("");
      reload();
      bump();
    } catch (e) {
      setErr(isTransient(e) ? "The engine is restarting, so the message was not sent. Try again in a few seconds." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel flex flex-col">
      <div className="p-4 border-b flex items-center gap-2" style={{ borderColor: "var(--rule)" }}>
        <div className="font-semibold">Captain</div>
        {reconnecting && <Reconnecting />}
        <span className="text-[12px] muted">orchestrator agent · can request, never sign</span>
      </div>
      <div className="p-4 flex flex-col gap-4">
        <section>
          <h3 className="section-title">Chat</h3>
          <div ref={chatRef} className="flex flex-col gap-2 max-h-[300px] overflow-auto pr-1">
            {chat.length === 0 && <div className="text-[12px] muted">Ask the captain about progress, or tell it what to change.</div>}
            {chat.map((m) => (
              <div key={m.id} className={`bubble ${m.kind === "user_message" ? "user self-end" : "self-start"}`} style={{ maxWidth: "92%" }}>
                <div className="text-[10.5px] muted mono">
                  {m.kind === "user_message" ? "you" : "captain"} · {timeOf(m.at)}
                </div>
                <div className="text-[13px] whitespace-pre-wrap">{m.text}</div>
                {m.sessionId && m.kind === "report" && (
                  <button type="button" className="btn btn-sm btn-ghost px-0 good" onClick={() => onSelectSession(m.sessionId!)}>
                    open session →
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-2">
            <input
              className="input"
              value={text}
              placeholder="Message the captain…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
              maxLength={2000}
            />
            <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={send}>
              Send
            </button>
          </div>
          {err && <div className="text-[12px] bad mt-1">{err}</div>}
        </section>

        <section>
          <div className="flex items-center gap-2">
            <h3 className="section-title m-0">Captain log</h3>
            <label className="ml-auto inline-flex items-center gap-1 text-[12px] cursor-pointer">
              <input type="checkbox" checked={showAbsorbed} onChange={(e) => setShowAbsorbed(e.target.checked)} /> show absorbed
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2 my-2">
            <div className="panel p-2" style={{ boxShadow: "none" }}>
              <div className="label">Woken (LLM call)</div>
              <div className="text-[20px] font-semibold tabular-nums">{log?.woken ?? "…"}</div>
            </div>
            <div className="panel p-2" style={{ boxShadow: "none" }}>
              <div className="label">Absorbed (no LLM call)</div>
              <div className="text-[20px] font-semibold tabular-nums">{log?.absorbed ?? "…"}</div>
            </div>
          </div>
          <ul className="timeline">
            {logEntries.map((e) => (
              <li key={e.id}>
                <span className="t">{timeOf(e.at)}</span>
                <span className={`dot ${e.kind === "woken" ? "warn" : e.kind === "action" ? "good" : ""}`} />
                <div className={e.kind === "absorbed" ? "muted" : undefined}>
                  <span className="mono text-[10.5px] muted">{e.kind}</span> {e.text}
                  {e.sessionId && (
                    <button type="button" className="btn btn-sm btn-ghost good" style={{ height: 18 }} onClick={() => onSelectSession(e.sessionId!)}>
                      →
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
