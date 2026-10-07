# Live run with the real AI on preprod (2026-10-07)

Captain: OpenAI gpt-5.4 · sub-agents: gpt-5.6-luna · chain: Cardano preprod via Blockfrost.
Goal: "Research the top 3 Cardano DEXs by trading volume and get a short paid market-research note on them" (budget 8 tUSD).

Notes: research sessions A and B were quarantined after a blocked egress attempt (api.llama.fi / sundaeswap.finance → sundae.fi redirect) and released by the user via the decision ledger; payments of C and D required user approval (amount ≥ approval threshold) and were approved via the decision ledger.

```
16:32:49 health {"ok":true,"network":"preprod","llm":"openai","chain":"blockfrost","simulatedChain":false,"at":1791304369899}
16:32:49 user u_940c22a2-5eff-400b-96bf-a2e83e826fdb addr_test1qzprfllgmyxmplaq7crps3xnc7s4a0gd7vsjtk3n4eq696s3hql5kaf52extzstxmc9q2jk9fj4vmtwkd62jnew6wk6q0kz7vj
16:32:57 top-up top_fe0d78d535a249ed {"ok":true,"topup":{"id":"top_fe0d78d535a249ed","amountMyr":"50.00","feeMyr":"0.75","tusdMicro":"10478723","simulated":true,"status":"submitted","txHash":"5e7c4e3fa3f97f111af9c06590da892a5e149c6d456d4
16:39:01 plan g_bf48a4d7-a731-4ee3-8c45-ac4fa1e0f155
16:39:01   - research researcher 0.5 tUSD | scope: https://defillama.com/chain/Cardano https://defillama.com/protocols/dexes https://taptools.io https://dexhunter.io https://www.coingecko.com | payees: 
16:39:01   - research researcher 0.5 tUSD | scope: https://minswap.org https://sundaeswap.finance https://www.wingriders.com https://muesliswap.com https://defillama.com/chain/Cardano | payees: 
16:39:01   - hire_agent hirer 2 tUSD | scope:  | payees: market-research
16:39:01   - hire_agent hirer 1.5 tUSD | scope:  | payees: fact-checker
16:39:02 approve {"ok":true,"fundingTx":"b4c1b0789e06e7341d0588eccb6053dff1b856625b5b0b5396e23fa6677fa1aa","sessionIds":["ses_8ae4369bb6824a08","ses_b1e0715736db495d","ses_6fa1e809671a4909","ses_e3adec2ebd31456e"]}
16:39:02 tree A:FUNDING B:FUNDING C:FUNDING D:FUNDING
16:39:32 tree A:QUARANTINED B:QUARANTINED C:FUNDING D:FUNDING
16:40:17 tree A:CLOSING B:CLOSING C:RUNNING D:FUNDING
16:40:32 tree A:CLOSED B:CLOSED C:RUNNING D:FUNDING job:running
16:51:33 tree A:CLOSED B:CLOSED C:CLOSING D:RUNNING job:closed job:running
16:51:48 tree A:CLOSED B:CLOSED C:CLOSED D:RUNNING job:closed job:running
16:52:48 tree A:CLOSED B:CLOSED C:CLOSED D:RUNNING job:closed job:closed
16:53:03 tree A:CLOSED B:CLOSED C:CLOSED D:CLOSING job:closed job:closed
16:53:18 tree A:CLOSED B:CLOSED C:CLOSED D:CLOSED job:closed job:closed
16:53:18    A researcher - CLOSED | Top 3: Minswap, SundaeSwap, WingRiders. Metric: 24h spot volume. Live numeric f… | spent RM0.00 · RM2.35 returned | close 629a2fc09289cc615331cc2f85d05788923c715f86f451e4176567c1ac4e6547
16:53:18    B researcher - CLOSED | Directly verified Minswap products and homepage metrics; quarantine prevented v… | spent RM0.00 · RM2.35 returned | close 46c3a0d2a68d5e3ba11492f4e7288318269953e92660a2fa9383df5062758404
16:53:18    C hirer - CLOSED | Paid Market Research Agent job completed; returned its result and matching hash. | spent RM9.40 · RM0.00 returned | close d8f8bf803e6e09baf23d6223351b7254f68078fc3fc6c2cc748d284f38b47354
16:53:18    D hirer - CLOSED | Fact-check completed: the note has no checkable specifics; ranking and competit… | spent RM7.05 · RM0.00 returned | close d4faccdb4c93cdc94b99fdd68547f90a5ae2a3a0d7406210618cfcb2a8e5c3ce
16:53:18    market-research - completed | # Market research note
Topic: Produce a short market-research note on the top 3… | paid RM9.40 · hash 155eb9a1c0… 
16:53:18    fact-checker - completed | # Fact-check report
1. "Verify the paid market note against the supplied resear… | paid RM7.05 · hash cb3c29cad9… 
16:53:18 captain {"woken":17,"absorbed":162,"entries":[{"id":2,"at":1791304371926,"kind":"absorbed","text":"Absorbed 1 routine event without an LLM call (topup_pending ×1)"},{"id":6,"at":1791304379837,"kind":"absorbed","text":"Absorbed 1 routine event without an LLM call (topup_submitted ×1)"},{"id":8,"at":1791304382681,"kind":"report","text":"Top-up confirmed: 10.478723 tUSD added. Treasury bal
16:53:18 DONE
exit 0
```
