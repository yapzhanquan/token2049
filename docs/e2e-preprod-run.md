# e2e:preprod — run of 2026-10-07 (Cardano preprod)

```
Bulkhead e2e — Cardano PREPROD
══════════════════════════════════════════════════════════════════════════════
PASS  1    Test user + simulated Stripe checkout RM50 → tUSD in the treasury (on-chain)  (33.9 s)
        ✓ custodial user u_bf05fb9c-1218-4add-95c3-a2da1a98a40f (treasury account 990001)
        ✓ top-up top_1922709a43ef435e: RM50.00 − fee RM0.75 @ 4.70 MYR/tUSD → 10.478723 tUSD
        ✓ signed test event evt_test_e2e_3e0fc64e3708ac8d35c2 → engine confirm → tx 2632a9af23e42ab1…
        ✓ re-delivered webhook event is idempotent (one tx)
        ✓ treasury +10.478723 tUSD and +25.000000 ADA on-chain (tx confirmed)
PASS  2    Goal → 3 sessions (research, hire_agent, buy_pay); ONE funding tx; all RUNNING together  (12.3 s)
        ✓ planner proposed research + hire_agent + buy_pay (funding preview fee 183365 lovelace)
        ✓ one funding tx 875cbb8dc4a500cc… with 3 outputs
        ✓ session wallets hold exactly A=0.5, B=3, C=2 tUSD (+ ADA for min-UTxO/fees)
        ✓ all 3 RUNNING at the same time for 303 ms (from transitions timestamps)
PASS  3    hire_agent session hires market-research: in-policy payment, result (agent_job node), handback w/ result_hash, closes  (21.1 s)
        ✓ payment 2 tUSD ≤ per-payment max 2 tUSD, payee on allowlist
        ✓ market-research job efe889d0-a3cf-4cc5-9f82-f39185b258f9 paid by 09f6945640eb… → completed (result_hash 93e22cb1e521…)
        ✓ handback submitted + accepted; agent_job child node in tree; H CLOSED (sweep 917a85c8a0b1…)
PASS  4    A later session starts with the hire_agent handback as contextIn (handback_passed)  (52.5 s)
        ✓ handback_passed B/hire_agent → D/research (event #153) before D/research RUNNING (#154); captain also passed: A/research→B/hire_agent by captain, B/hire_agent→C/buy_pay by captain, B/hire_agent→D/research by captain
PASS  5    buy_pay session: pay() to a NOT-allowlisted payee → payment_rejected; untrusted page → QUARANTINED → killed → closes  (24.1 s)
        ✓ Signer rejected 0.5 tUSD → addr_test1qpkp2y7ac4… (payee_not_allowed)
        ✓ fetched http://127.0.0.1:53299/untrusted-page (flagged untrusted) → QUARANTINED + open quarantine_release decision
        ✓ killed → CLOSING → CLOSED, budget 2 tUSD swept back
PASS  6    v2: user message to a running session (mandate change ignored) + ONE payment approved via the decision ledger  (21.8 s)
        ✓ decision dec_81f9e45f92eb4590 opened: 2 tUSD ≥ approval threshold 1
        ✓ message delivered (session_message); mandate change ignored (raise_budget, budget_amount, add_payee, new_address); mandate unchanged
        ✓ payment 2 tUSD approved → confirmed on-chain 09f6945640eb46c0…
PASS  7    All sessions: CLOSED, wallets empty, treasury = start − spend − fees, close metadata 674, full tree  (2.1 s)
        ✓ all 5 sessions CLOSED (A:COMPLETED, B:COMPLETED, C:KILLED, D:COMPLETED, E:EXPIRED)
        ✓ every session address balance = 0 (no UTxOs)
        ✓ each close tx carries metadata 674 {session_id, log_sha256, handback_sha256, status} matching the DB (E: owner-recovery tx)
        ✓ treasury: 10.478723 tUSD − spend 2 tUSD = 8.478723 tUSD; 25.000000 ADA − fees 1.705989 ADA (3 funding + 5 sweeps/recovery + payments) − payee min-ADA 1.155080 ADA = 22.138931 ADA
        ✓ tree: 7 nodes (5 sessions incl. killed/expired, agent_job), 3 handback edge(s), summaries on 3 nodes
PASS  8    Restart: engine shut down mid-run, re-wired on the same DB → reconcile → sessions still close  (48.8 s)
        ✓ reconcile after restart: D/research RUNNING, wallet balance read from chain, silo restarted from its checkpoint
        ✓ D/research completed its handback after the restart and CLOSED (sweep 5b086d594e49…)
PASS  9    Expiry: session NOT closed by the app → owner recovery after the expiry slot → funds back to the owner  (619.5 s)
        ✓ E RUNNING with expiry slot 135620024 (2026-10-06T16:13:44.558Z)
        ✓ recover before the expiry slot: refused, nothing submitted
        ✓ owner sweep 7d5ec4013cf3… returned 0.5 tUSD + 1.963223 ADA to the owner treasury
        ✓ engine restarted: reconcile saw the expiry + empty wallet → E EXPIRED → CLOSED (no double sweep)

Explorer links (https://preprod.cardanoscan.io):
  operator wallet
    https://preprod.cardanoscan.io/address/addr_test1qp7fqfzme6yx2h7pzsvrph9r8l4vq72mnyhp9whgt3qmlqxaz43ftv5hex8qdt0z6m4zje8fp6cr73ega3rleq63pz4qxmwku6
  e2e user treasury
    https://preprod.cardanoscan.io/address/addr_test1qzct74k8nw6aeya56n93wgdrsnmeeal0x8zmfvvn9xxzaxl20zt60hgzj2fn2gzt25yuthfs86ulq5ajyhxkll95q75qug52y9
  top-up (operator → treasury)
    https://preprod.cardanoscan.io/transaction/2632a9af23e42ab1592014d035ae36c247f6d471fdf2e53486534ce0fa8a76e7
  market-research agent wallet
    https://preprod.cardanoscan.io/address/addr_test1qra72xznumc3fg4qsr8mmdyrzrdw45nh790h2s36pladqn9f65nslquzy5fq66337vv94ef9ayra0h2y2annmjtexresm3787g
  funding tx (treasury → 3 session wallets)
    https://preprod.cardanoscan.io/transaction/875cbb8dc4a500cc2db168a9f988835b4bfc78c5963cf04957954f68e10a7dbb
  session A (research) wallet
    https://preprod.cardanoscan.io/address/addr_test1zrrt6xtqx8lh6udjr57ptg8ywsuu4njn70s7yfu7vm23n3l20zt60hgzj2fn2gzt25yuthfs86ulq5ajyhxkll95q75q34tuq7
  session B (hire_agent) wallet
    https://preprod.cardanoscan.io/address/addr_test1zr86523yekh5yfq97urtuahp9faylm8csfsntdxttuz98d820zt60hgzj2fn2gzt25yuthfs86ulq5ajyhxkll95q75q4e7xlk
  session C (buy_pay) wallet
    https://preprod.cardanoscan.io/address/addr_test1zr3xn5kklw2h9jcr7zm3qr89qeszx3hd74zwu4ue973eve020zt60hgzj2fn2gzt25yuthfs86ulq5ajyhxkll95q75qyra6uw
  hire payment (session B → market-research, approved via the decision ledger)
    https://preprod.cardanoscan.io/transaction/09f6945640eb46c046dde24bf5c6c89a4f24386aa3010511281fbba06c1b6887
  session B (hire_agent) close/sweep
    https://preprod.cardanoscan.io/transaction/917a85c8a0b12eec79b352d8e385774b6935ebacae2fa3a77a0cbf6cf8608fe2
  session C (buy_pay, killed) close/sweep
    https://preprod.cardanoscan.io/transaction/89329109d9d080b84fa237096aa619e33bcfeac7c5cc4cb299fef746b107379e
  funding tx (follow-up session D)
    https://preprod.cardanoscan.io/transaction/3160492c748f7e603b12b67ab4d2d0f1c3295326c6af53f544785b992d235e68
  session D (follow-up) wallet
    https://preprod.cardanoscan.io/address/addr_test1zp5xvmfhkv9dg7kq4arzq9kwtr058as2wppqujwzuamqpw020zt60hgzj2fn2gzt25yuthfs86ulq5ajyhxkll95q75q7lgllv
  session D (follow-up) close/sweep after the restart
    https://preprod.cardanoscan.io/transaction/5b086d594e495f6f5d8b289e827b702c54670f2b7c850d20052e3f0145f0a91c
  funding tx (expiry-test session E)
    https://preprod.cardanoscan.io/transaction/812cc5a141a0a067b5819b759268660171aaf946cadbde655b8d8dc39accb1fb
  session E (expiry test) wallet
    https://preprod.cardanoscan.io/address/addr_test1zpf6flwlynset7wrg4ggnq3h40ljuna5afskvu9rg0y9d6820zt60hgzj2fn2gzt25yuthfs86ulq5ajyhxkll95q75qm8cznh
  session E owner recovery sweep (pnpm recover, after expiry)
    https://preprod.cardanoscan.io/transaction/7d5ec4013cf33fcbd941827bafaaf9901a0dff2903e000e50fbef929030dd913
  session A (research) close/sweep
    https://preprod.cardanoscan.io/transaction/c1aaabf3dad2b954b2d825270ee1d107e561c3f931969d1913094092ba2a4ee9

DB kept for inspection: C:\Users\ZHANQU~1\AppData\Local\Temp\bulkhead-e2e-55zycl\e2e.sqlite

PASSED: 9/9 steps passed (preprod)
══════════════════════════════════════════════════════════════════════════════
```
