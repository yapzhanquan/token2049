// Bulkhead Session Vault — typed client (docs/VAULT-SPEC.md). Contract: contracts/validators/session_vault.ak,
// blueprint contracts/plutus.json (embedded as ./blueprint.generated.ts; regenerate with
// `node contracts/scripts/gen-ts.mjs` after `aiken build`).
export {
  applyVaultParams,
  addressToPlutusJson,
  addressCredentials,
  vaultParamsToPlutusJson,
  validateVaultParams,
  vaultParamsToJson,
  vaultParamsFromJson,
  isVaultParamsJson,
  unappliedVaultHash,
  VaultRedeemer,
  VAULT_DATUM_VOID,
  UNAPPLIED_VAULT_HASH,
  VAULT_SCRIPT_VERSION,
  VAULT_PLUTUS_VERSION,
  VAULT_AIKEN_VERSION,
  MAX_VAULT_PAYEES,
  VaultParamsError,
  type VaultParams,
  type VaultParamsJson,
  type AppliedVault,
  type VaultAction,
  type PlutusJson,
} from "./params";
export {
  buildVaultPay,
  buildVaultRevoke,
  buildVaultRecover,
  providerEvaluator,
  offlineEvaluator,
  vaultPayTtlSlot,
  vaultRecoverFromSlot,
  slotAtOrBefore,
  slotStartMs,
  VaultScriptError,
  type ExBudget,
  type VaultEvaluator,
  type VaultTxResult,
  type VaultBuildCommon,
  type BuildVaultPayArgs,
  type BuildVaultRevokeArgs,
  type BuildVaultRecoverArgs,
  type Metadata674,
} from "./build";
export { VaultOps, NoCollateralError, pickCollateral, selectPayInputs, isScriptFailureText, txOutputInfo, MIN_COLLATERAL_LOVELACE, type VaultTxServiceResult } from "./service";
export { VAULT_BLUEPRINT } from "./blueprint.generated";
export { createThrowawayKey, createThrowawayWallet, type ThrowawayKey, type ThrowawayWallet } from "./throwaway";
export { ensureCaptainCollateral } from "./setup";
