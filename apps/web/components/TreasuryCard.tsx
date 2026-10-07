"use client";
// Treasury staking card: "Staked to <pool>" + tx link, "Voting power delegated: Always abstain / <DRep>",
// stake + delegate action (optional pool / DRep id), and "Stop staking" behind a confirm dialog.
// Self-custody users sign the certificate tx in their CIP-30 wallet (postSigned → needsSignature flow).
import { useState } from "react";
import { drepDisplay, microToTusd, type MeDTO, type StakingActionResponse, type StakingStatusDTO } from "@bulkhead/shared";
import { postSigned, useResource } from "@/lib/client";
import { useWalletSigner } from "@/lib/wallet-context";
import { ada, shortAddr, TICKER } from "@/lib/money";
import { TxLink } from "./Links";
import { Modal } from "./Modal";

const poolLabel = (s: StakingStatusDTO) => (s.poolTicker ? s.poolTicker : s.poolId ? shortAddr(s.poolId, 8) : "—");

/** Compact chip for the top bar; opens the full card. */
export function TreasuryStakingChip() {
  const { data, reload } = useResource<StakingStatusDTO>("/staking");
  const [open, setOpen] = useState(false);
  if (!data || !data.available) return null;
  const staked = data.registered && !!data.poolId;
  return (
    <>
      <button
        type="button"
        className={`tag ${staked ? "tag-good" : ""}`}
        style={{ cursor: "pointer" }}
        onClick={() => setOpen(true)}
        title={staked ? `Staked to ${data.poolId} · vote: ${drepDisplay(data.drep)}` : "Stake your treasury (testnet)"}
      >
        {data.pending ? "Staking…" : staked ? `Staked · ${poolLabel(data)}` : "Not staked"}
      </button>
      {open && (
        <Modal title="Treasury staking" subtitle="Stake delegation + vote delegation on Cardano preprod" onClose={() => setOpen(false)} width={520}>
          <TreasuryCard status={data} onChanged={reload} />
        </Modal>
      )}
    </>
  );
}

/** tUSD token line: CIP-68 (333) fungible token + its CIP-14 fingerprint (asset1…), linked to the explorer. */
function TusdTokenRows() {
  const { data: me } = useResource<MeDTO>("/me");
  const t = me?.tusdToken;
  if (!t) return null;
  const legacy = me?.balances.legacyTusdMicro;
  return (
    <>
      <dt>{TICKER} token</dt>
      <dd>
        <span className="mono" title={t.unit}>
          {t.fingerprint}
        </span>{" "}
        {me?.mode !== "fixture" && me?.chain !== "fake" && (
          <a className="good" href={`https://preprod.cardanoscan.io/token/${t.unit}`} target="_blank" rel="noreferrer" title={`policy ${t.policyId}`}>
            ↗
          </a>
        )}
        <div className="muted text-[12px]">
          {t.standard === "CIP-68 (333)" ? "CIP-68 fungible token (label 333); metadata in the (100) reference NFT datum" : "legacy asset name"} · CIP-14
          fingerprint
        </div>
        {legacy && legacy !== "0" && (
          <div className="muted text-[12px]">+ {microToTusd(BigInt(legacy))} tUSD in the deprecated pre-CIP-68 unit (migrated 1:1 by setup:chain)</div>
        )}
      </dd>
    </>
  );
}

export function TreasuryCard({ status, onChanged }: { status: StakingStatusDTO; onChanged: () => void }) {
  const sign = useWalletSigner();
  const [busy, setBusy] = useState<null | "setup" | "stop">(null);
  const [err, setErr] = useState<string | null>(null);
  const [drepId, setDrepId] = useState("");
  const [poolId, setPoolId] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const s = status;
  const lastSetup = [...s.txs].reverse().find((t) => t.kind === "setup");
  const lastStop = [...s.txs].reverse().find((t) => t.kind === "stop");
  const staked = s.registered && !!s.poolId;

  const run = async (kind: "setup" | "stop") => {
    setBusy(kind);
    setErr(null);
    try {
      const body: Record<string, unknown> =
        kind === "setup" ? { ...(poolId.trim() ? { poolId: poolId.trim() } : {}), ...(drepId.trim() ? { drepId: drepId.trim() } : {}) } : { confirm: true };
      await postSigned<StakingActionResponse>(`/staking/${kind}`, body, sign);
      setConfirmStop(false);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <dl className="kv">
        <dt>Stake address</dt>
        <dd className="mono" title={s.stakeAddress ?? ""}>
          {s.stakeAddress ? shortAddr(s.stakeAddress, 12) : "—"}
        </dd>
        <dt>Staking</dt>
        <dd>
          {staked ? (
            <>
              Staked to <b>{poolLabel(s)}</b> {lastSetup && <TxLink hash={lastSetup.txHash} />}
            </>
          ) : (
            <span className="muted">Not staked</span>
          )}
          {s.pending && <span className="tag tag-run ml-2">pending confirmation</span>}
        </dd>
        <dt>Voting power delegated</dt>
        <dd>{s.drep ? <b className="mono">{drepDisplay(s.drep)}</b> : <span className="muted">not delegated</span>}</dd>
        <dt>Deposit</dt>
        <dd>{s.depositLovelace ? `${ada(s.depositLovelace)} (refunded when you stop staking)` : "—"}</dd>
        <TusdTokenRows />
        <dt>Rewards</dt>
        <dd>{ada(s.rewardsLovelace)} <span className="muted">(not claimed in the demo; preprod epochs take days)</span></dd>
        {lastStop && !staked && (
          <>
            <dt>Stopped</dt>
            <dd>
              <TxLink hash={lastStop.txHash} />
            </dd>
          </>
        )}
      </dl>
      {!s.live && s.reason && <div className="muted text-[12px]">{s.reason}</div>}
      <p className="muted text-[12px]">
        Since the Conway era a stake key must delegate its vote (to a DRep, or “Always abstain”) before rewards can be withdrawn. Bulkhead defaults to
        Always abstain. Session wallets use your treasury’s stake key, so session budgets keep counting toward your stake.
      </p>
      {!staked && (
        <div className="flex flex-col gap-2">
          <label className="label" htmlFor="drep">
            DRep id (optional — empty = Always abstain)
          </label>
          <input id="drep" className="input mono" placeholder="drep1… or always_abstain" value={drepId} onChange={(e) => setDrepId(e.target.value)} />
          <label className="label" htmlFor="pool">
            Pool id (optional — empty = default preprod pool)
          </label>
          <input id="pool" className="input mono" placeholder="pool1…" value={poolId} onChange={(e) => setPoolId(e.target.value)} />
          <button type="button" className="btn btn-primary" disabled={!!busy || s.pending} onClick={() => run("setup")}>
            {busy === "setup" ? "Submitting…" : s.registered ? "Delegate stake + vote" : "Stake treasury + delegate vote"}
          </button>
          {s.custody === "self" && !sign && <span className="muted text-[12px]">Connect your wallet to sign.</span>}
        </div>
      )}
      {staked && !confirmStop && (
        <button type="button" className="btn btn-danger" disabled={!!busy || s.pending} onClick={() => setConfirmStop(true)}>
          Stop staking
        </button>
      )}
      {confirmStop && (
        <div className="banner banner-warn flex flex-col gap-2" role="alertdialog" aria-label="Confirm stop staking">
          <span>
            Stop staking? This deregisters your stake key (any rewards are withdrawn in the same transaction) and refunds the{" "}
            {s.depositLovelace ? ada(s.depositLovelace) : "stake key"} deposit. Your funds stay in your treasury.
          </span>
          <div className="flex gap-2">
            <button type="button" className="btn btn-danger" disabled={!!busy} onClick={() => run("stop")}>
              {busy === "stop" ? "Submitting…" : "Yes, stop staking"}
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => setConfirmStop(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && <div className="bad text-[12px]">{err}</div>}
    </div>
  );
}
