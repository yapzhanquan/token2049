"use client";
// Trust receipts: per session, a compact card of what the CONTRACT enforces ("Enforced by contract <hash> · payees 2 ·
// cap 3 tUSDM/tx · expires …") and a "Verify on-chain" button that runs lib/verify-proof.ts IN THE BROWSER:
// the vault's script hash + address are recomputed from its parameters and the bundled contracts/plutus.json, and
// every funding / payment / close tx is read from Blockfrost (via the read-only /api/chain proxy) — the engine's
// word is never used for a ✓. Goal level: <GoalTrustReceipts goalId> lists every session with "Verify all".
//
// Exports: TrustReceipt (one session, fetches GET /sessions/:id/proof), GoalTrustReceipts (GET /goals/:id/proof),
// SessionReceiptCard (presentational, for callers that already hold a SessionProofDTO).
import { useCallback, useRef, useState } from "react";
import type { ClaimResult, GoalProofDTO, SessionProofDTO, SessionVerification, VerifyClaimId } from "@bulkhead/shared";
import { useConfig, useResource } from "@/lib/client";
import { dateTimeOf, shortHash } from "@/lib/money";
import { proxyReader, receiptSummary, verifySession, type ChainReader, type CstLike } from "@/lib/verify-proof";
import { loadBrowserCst } from "@/lib/verify-proof-browser";

const LABEL: Record<VerifyClaimId, string> = {
  contract: "Contract",
  vault_address: "Vault address",
  funding: "Funding",
  payments: "Payments",
  history: "Complete history",
  close: "Close / refund",
  handback: "Result anchored",
};

let cstPromise: Promise<CstLike> | null = null;
const browserCst = () => (cstPromise ??= loadBrowserCst().catch((e) => {
  cstPromise = null;
  throw e;
}));

async function runVerify(proof: SessionProofDTO, reader: ChainReader): Promise<SessionVerification> {
  return verifySession(proof, { reader, cst: await browserCst() });
}

type RunState = { running: boolean; result: SessionVerification | null; error: string | null };
const IDLE: RunState = { running: false, result: null, error: null };

function Mark({ status }: { status: ClaimResult["status"] }) {
  if (status === "pass") return <span className="good" aria-label="verified">✓</span>;
  if (status === "fail") return <span className="bad" aria-label="failed">✗</span>;
  return <span className="muted" aria-label="not applicable">–</span>;
}

function VerdictTag({ state }: { state: RunState }) {
  if (state.running) return <span className="tag tag-run">Verifying…</span>;
  if (state.error) return <span className="tag tag-bad" title={state.error}>Could not verify</span>;
  const r = state.result;
  if (!r) return null;
  const checked = r.claims.filter((c) => c.status !== "skip");
  const failed = checked.filter((c) => c.status === "fail").length;
  if (failed) return <span className="tag tag-bad">✗ {failed} of {checked.length} failed</span>;
  if (checked.length === 0) return <span className="tag">Nothing to verify yet</span>;
  return (
    <span className="tag tag-good" title={`Verified ${new Date(r.verifiedAt).toLocaleString()}`}>
      ✓ {checked.length}/{checked.length} verified on-chain
    </span>
  );
}

/** Presentational card for one session's trust receipt. */
export function SessionReceiptCard({ proof, state, onVerify, disabled }: { proof: SessionProofDTO; state: RunState; onVerify: () => void; disabled?: boolean }) {
  const s = receiptSummary(proof);
  const vault = !!proof.vault;
  return (
    <div className="panel" style={{ padding: "10px 12px" }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="mono" style={{ fontWeight: 600 }}>{proof.letter}</span>
        <span className="mid">{proof.role}</span>
        <span className={`tag ${vault ? "tag-good" : "tag-warn"}`} title={vault ? `Bulkhead Session Vault v${proof.vault!.scriptVersion} (Plutus V3)` : "Native-script fallback: payees and caps are enforced by the engine"}>
          {vault ? "On-chain mandate" : "Engine-enforced"}
        </span>
        <span className="flex-1" />
        <VerdictTag state={state} />
        <button type="button" className="btn btn-sm" onClick={onVerify} disabled={disabled || state.running} title="Recompute the contract address and check every tx on Cardano preprod, in your browser">
          {state.result ? "Re-verify" : "Verify on-chain"}
        </button>
      </div>
      <div className="text-[12.5px] mid" style={{ marginTop: 4 }}>
        Enforced by{" "}
        <span className="mono" title={proof.vault?.appliedScriptHash ?? proof.native?.scriptHash ?? undefined}>
          {s.enforcedBy}
        </span>{" "}
        · payees {s.payees} · cap {s.cap}
        {s.expires ? <> · expires {dateTimeOf(s.expires)}</> : null}
      </div>
      {state.error && <div className="banner banner-bad" style={{ marginTop: 8 }}>{state.error}</div>}
      {state.result && (
        <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 6 }}>
          {state.result.claims.map((c) => (
            <li key={c.id} className="text-[12.5px]" style={{ display: "grid", gridTemplateColumns: "16px 1fr", gap: 6 }}>
              <Mark status={c.status} />
              <div style={{ minWidth: 0 }}>
                <b title={c.statement}>{LABEL[c.id]}</b> <span className={c.status === "fail" ? "bad" : "mid"} style={{ overflowWrap: "anywhere" }}>{c.detail}</span>
                {c.links.length > 0 && (
                  <span className="muted">
                    {" "}
                    {c.links.map((l) => (
                      <a key={l.url + l.label} className="good" href={l.url} target="_blank" rel="noreferrer" style={{ marginRight: 8, whiteSpace: "nowrap" }}>
                        {l.label} ↗
                      </a>
                    ))}
                  </span>
                )}
              </div>
            </li>
          ))}
          {state.result.recomputed && (
            <li className="text-[11.5px] muted" style={{ paddingLeft: 22 }}>
              Recomputed in this browser from the bundled plutus.json: script <span className="mono">{shortHash(state.result.recomputed.scriptHash)}</span>. Chain data read
              directly from Blockfrost; the engine&apos;s hashes are compared, never trusted.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** One session's trust receipt (fetches GET /sessions/:id/proof). */
export function TrustReceipt({ sessionId }: { sessionId: string }) {
  const { fixture } = useConfig();
  const { data, error } = useResource<SessionProofDTO>(`/sessions/${encodeURIComponent(sessionId)}/proof`);
  const [state, setState] = useState<RunState>(IDLE);
  const verify = useCallback(async () => {
    if (!data) return;
    setState({ running: true, result: null, error: null });
    try {
      setState({ running: false, result: await runVerify(data, proxyReader()), error: null });
    } catch (e) {
      setState({ running: false, result: null, error: (e as Error).message });
    }
  }, [data]);
  if (error) return fixture ? <div className="muted text-[12.5px]">Trust receipt: available with the live engine.</div> : <div className="banner">Trust receipt unavailable: {error}</div>;
  if (!data) return <div className="muted text-[12.5px]">Loading trust receipt…</div>;
  return <SessionReceiptCard proof={data} state={state} onVerify={verify} disabled={fixture} />;
}

/** Every session of a goal, with a goal-level "Verify all" (fetches GET /goals/:id/proof). */
export function GoalTrustReceipts({ goalId }: { goalId: string }) {
  const { fixture } = useConfig();
  const { data, error } = useResource<GoalProofDTO>(`/goals/${encodeURIComponent(goalId)}/proof`);
  const [states, setStates] = useState<Record<string, RunState>>({});
  const busy = useRef(false);
  const set = (id: string, s: RunState) => setStates((m) => ({ ...m, [id]: s }));

  const verifyOne = useCallback(async (p: SessionProofDTO, reader: ChainReader) => {
    set(p.sessionId, { running: true, result: null, error: null });
    try {
      set(p.sessionId, { running: false, result: await runVerify(p, reader), error: null });
    } catch (e) {
      set(p.sessionId, { running: false, result: null, error: (e as Error).message });
    }
  }, []);

  const verifyAll = useCallback(async () => {
    if (!data || busy.current) return;
    busy.current = true;
    const reader = proxyReader(); // one cache for the whole goal (shared funding tx)
    try {
      for (const p of data.sessions) await verifyOne(p, reader);
    } finally {
      busy.current = false;
    }
  }, [data, verifyOne]);

  if (error) return <div className="banner">Trust receipts unavailable: {error}</div>;
  if (!data) return <div className="muted text-[12.5px]">Loading trust receipts…</div>;
  const results = data.sessions.map((p) => states[p.sessionId]?.result).filter((r): r is SessionVerification => !!r);
  const anyRunning = data.sessions.some((p) => states[p.sessionId]?.running);
  const failed = results.filter((r) => r.status === "fail").length;
  const vaults = data.sessions.filter((p) => p.vault).length;
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="section-title" style={{ margin: 0 }}>Trust receipts</h3>
        <span className="muted text-[12px]">
          {vaults}/{data.sessions.length} session{data.sessions.length === 1 ? "" : "s"} enforced by contract
        </span>
        <span className="flex-1" />
        {results.length === data.sessions.length && results.length > 0 && !anyRunning && (
          <span className={`tag ${failed ? "tag-bad" : "tag-good"}`}>{failed ? `✗ ${failed} session${failed === 1 ? "" : "s"} failed` : "✓ all sessions verified on-chain"}</span>
        )}
        <button type="button" className="btn btn-sm btn-primary" onClick={verifyAll} disabled={fixture || anyRunning || data.sessions.length === 0}>
          {anyRunning ? "Verifying…" : "Verify all on-chain"}
        </button>
      </div>
      {fixture && <div className="banner">Fixture data: nothing on-chain to verify.</div>}
      {data.sessions.map((p) => (
        <SessionReceiptCard key={p.sessionId} proof={p} state={states[p.sessionId] ?? IDLE} onVerify={() => void verifyOne(p, proxyReader())} disabled={fixture || anyRunning} />
      ))}
    </section>
  );
}
