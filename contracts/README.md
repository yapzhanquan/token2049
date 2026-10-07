# Bulkhead Session Vault (Aiken, Plutus V3)

- Validator: `validators/session_vault.ak`. Tests: `validators/session_vault.test.ak` (unit and property tests).
- Compiler: Aiken v1.1.24, `aiken-lang/stdlib` v3.0.0, `aiken-lang/fuzz` v2.1.1.

```sh
aiken check                      # 43 tests (36 unit + 7 property)
aiken build                      # → plutus.json (CIP-57 blueprint; committed)
node scripts/gen-ts.mjs          # → packages/chain/src/vault/blueprint.generated.ts
```

If the compiled hash changes, `packages/chain/test/vault.test.ts` fails until `VAULT_SCRIPT_VERSION` and
`UNAPPLIED_VAULT_HASH` (packages/chain/src/vault/params.ts) are bumped and the new pair is pinned.
See `../DEPLOYMENTS.md` and `../docs/VAULT-SPEC.md`.
