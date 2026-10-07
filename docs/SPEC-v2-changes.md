# Spec v2 changes (from the user, applied on top of ../bulkhead-build-prompt.md)

These modify section 5 (orchestrator) and section 6 (UI). Everything else stays as in the base spec.

## 1. The captain is an AI agent with tools (Firstmate model)
Reference pattern: https://github.com/kunchenguid/firstmate (README "What it is", "Features", docs/architecture.md).
The first mate there is an ordinary LLM agent that runs a crew through deterministic helper scripts, and a
zero-token watcher wakes it only when something is actionable. Copy that split:
- The captain is an LLM agent loop (Anthropic provider, MockLLM fallback) with tools:
  plan_task(goal, budget, deadline, rules), spawn_session(spec), message_session(id, text),
  read_status(id | all), pause_session(id), resume_session(id), kill_session(id),
  pass_handback(fromId, toId), request_user_approval(kind, details), report_to_user(text).
- Existing services (SessionManager, SiloRunner, Signer, TxService, TreasuryQueue, ChainWatcher, EventBus)
  are the captain's tools and guard rails. They enforce every money and safety rule even if the captain's
  LLM makes a mistake. The captain can REQUEST a payment, a budget raise or an extension; only the
  Signer + user approval + the chain can ALLOW it. The captain never holds keys.
- The captain does not run continuously. The EventBus wakes it only for actionable events: a session
  finished / failed / went quiet (missed heartbeats); an approval is needed; a payment was rejected; a
  quarantine; a deposit confirmed; a deadline is near; a user message. Routine progress is absorbed
  without an LLM call. Log absorbed vs woken events so this is visible.
- Restart-proof: on wake it reads current state from the DB + chain, never from its own memory alone.

## 2. Message one session directly
- Each session card / detail panel gets a message box. The user (or the captain via message_session)
  can send a message to that session's sub-agent.
- Messages are delivered over IPC as DATA. They can change what the agent works on, but can NEVER
  change its mandate (budget, payees, per-payment max, expiry, approval threshold). Only the mandate
  controls in 5.8 can, and widening still needs user approval.
- Show the conversation in the session's activity timeline.
- Add a "peek" view: a live read-only stream of the session's progress/log lines.

## 3. Task types with a definition of done
Every session has a taskType; each has an allowed tool list and a definition of done the captain checks
before accepting a handback:
- research: tools web_fetch, report_progress, submit_handback (no pay). Done = result + summary + ≥1 source.
- buy_pay: tools pay, report_progress, submit_handback (no web_fetch unless the plan allows it).
  Done = every payment confirmed on-chain (tx hashes in the handback).
- hire_agent: tools hire_agent, report_progress, submit_handback. Done = paid job completed, with
  result + result_hash matching the paid agent's response.
- monitor: tools read_chain (read-only chain reads), report_progress, submit_handback. Done = the watched
  condition happened or the deadline passed, with a report.
- A handback that fails its definition of done is returned to the session once, with the reason. If it
  fails again: FAILED → CLOSING, and the captain reports to the user.
- The SiloRunner must refuse tool calls not allowed for the session's type (logged as tool_denied).

## 4. Decision ledger
- Table `decisions`: { id, sessionId, kind (payment_approval | budget_raise | extend_expiry |
  quarantine_release | widen_mandate), requestedBy (captain | session), details, status (open | approved |
  rejected | expired), decidedBy, decidedAt }.
- Every escalation creates exactly one open decision (no duplicates for the same request). Answering it
  closes it, and the answer is relayed to the session.
- UI: an "Open decisions" badge in the top bar and a Decisions list; each decision links to its node.

## 5. After-MVP (README roadmap only; do not build)
Cloud runners / "secondmates"; Docker/VM silo isolation (SiloRunner already allows it); Tier 2 Aiken
mandate vault + CIP-68 (§3.3).

## Tests to add
- Captain wake filter: routine report_progress events don't trigger an LLM call; actionable events do
  (assert via MockLLM call count).
- message_session cannot change the mandate (attempt to raise budget via a message is ignored + logged).
- Every task type: a disallowed tool call is denied; definition of done enforced (fail once → retry,
  fail twice → FAILED → CLOSING with funds swept).
- Decision ledger: one open decision per request, closed on answer, relayed to the session.
- e2e:preprod: one research, one hire_agent and one buy_pay session; send one user message to a running
  session; approve one payment through the decision ledger. All previous assertions still pass.
