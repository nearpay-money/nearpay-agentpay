/** Kysely table types (migrations/0001_agentpay.sql … 0004_near_intents.sql). numeric(78,0) columns read as decimal strings. */
import type { ColumnType, KitTables } from "@nearpay-internal/db";
import type { AgentPaymentKind, AgentPaymentStatus } from "../../domain/facilitator-payment/status.js";

export type { AgentPaymentKind, AgentPaymentStatus };

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type OptTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Def<T> = ColumnType<T, T | undefined, T>;
type Opt<T> = ColumnType<T | null, T | null | undefined, T | null>;
type Json<T> = ColumnType<T, string, string>;
/** numeric(78,0) */
type Num = ColumnType<string, string | bigint, string | bigint>;
type OptNum = ColumnType<string | null, string | bigint | null | undefined, string | bigint | null>;
/** int8 columns read as bigint (kit type parser) */
type BigCol = ColumnType<bigint, string | bigint | number, string | bigint | number>;
type OptBig = ColumnType<bigint | null, string | bigint | number | null | undefined, string | bigint | number | null>;

export interface ResourceJson {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface IntentsRequirementJson {
  pay_to: string;
  token: string;
  amount: string;
  fee_to: string;
  fee_amount: string;
  binding: string;
  deadline: string;
}

export interface IssuedRequirementsTable {
  binding: string;
  account_id: string;
  livemode: boolean;
  resource_url: string;
  resource: Json<ResourceJson>;
  pay_to: string;
  asset_id: string;
  amount: Num;
  /** Null for near-intents rows (the fee is inside the 1Click quote; 0004). */
  fee_to: Opt<string>;
  fee_amount: Num;
  max_timeout_s: number;
  nonce16: string;
  expires_at: Timestamp;
  consumed_at: OptTimestamp;
  consumed_by: Opt<string>;
  created_at: Timestamp;
  /** 0004: `intents-transfer` (Stage 1) or `near-intents` (Stage 3, §3.1). */
  method: Def<RequirementMethod>;
  origin_network: Opt<string>;
  origin_asset_id: Opt<string>;
  origin_asset: Opt<string>;
  /** The unquoted near-intents `accepts[]` entry exactly as issued. */
  entry: ColumnType<unknown | null, string | null | undefined, string | null>;
}

export type RequirementMethod = "intents-transfer" | "near-intents";
export type TransferMethod = RequirementMethod;

/** `AgentPaymentOrigin` (spec 0.3.0) as stored on near-intents agent payments. */
export interface AgentPaymentOriginJson {
  network: string;
  asset_id: string;
  amount_in: string | null;
  refund_to: string;
  deposit_address: string;
  deposit_memo: string | null;
  tx_hashes: string[];
  fee: { amount: string; asset_id: string } | null;
}

export type OperationStatus = "quoted" | "settled" | "failed";

/** One minted near-intents quote (0004, §4.1). */
export interface X402OperationsTable {
  id: string;
  account_id: string;
  livemode: boolean;
  binding: string;
  execution_id: string;
  network: string;
  deposit_address: string;
  deposit_memo: string | null;
  refund_to: string;
  amount_in: Num;
  refund_deadline: Timestamp;
  token_sha256: Buffer;
  token_kid: string;
  token_expiry: Timestamp;
  status: OperationStatus;
  result: ColumnType<unknown | null, string | null | undefined, string | null>;
  result_reported_at: OptTimestamp;
  execution_version: Opt<number>;
  agent_payment_id: Opt<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CheckoutRequirementsTable {
  binding: string;
  account_id: string;
  livemode: boolean;
  checkout_session_id: string;
  attempt_id: string;
  execution_id: string;
  payer: string;
  requirement: Json<IntentsRequirementJson>;
  attestation_ticket: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AgentPaymentsTable {
  id: string;
  account_id: string;
  livemode: boolean;
  kind: AgentPaymentKind;
  binding: string;
  payer: string;
  pay_to: string;
  /** Null for refund legs (no NearPay fee; 0003). */
  fee_to: Opt<string>;
  /** Null for near-intents rows (no signed payload; 0004). */
  payload_hash: Buffer | null;
  payload: ColumnType<unknown | null, string | null | undefined, string | null>;
  standard: string | null;
  intent_hashes: Opt<string[]>;
  nonces: string[] | null;
  deadline: OptTimestamp;
  status: AgentPaymentStatus;
  amount: Num;
  asset_id: string;
  fee_amount: Num;
  resource_url: Opt<string>;
  checkout_session_id: Opt<string>;
  solo: Def<boolean>;
  batch_id: Opt<string>;
  tx_hash: Opt<string>;
  block_height: OptBig;
  error_reason: Opt<string>;
  execution_id: Opt<string>;
  /** payments refund (`re_…` uuid) of a `refund` relay (0003). */
  refund_id: Opt<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
  settled_at: OptTimestamp;
  /** First /x402/settle response that carried the final outcome (0002; later ones are `replayed`). */
  result_reported_at: OptTimestamp;
  version: Def<number>;
  /** 0004: how the payment reached the merchant. */
  transfer_method: Def<TransferMethod>;
  /** 0004: `AgentPaymentOrigin` of a near-intents payment, else null. */
  origin: ColumnType<AgentPaymentOriginJson | null, string | null | undefined, string | null>;
}

export interface AgentPaymentTransitionsTable {
  id: string;
  agent_payment_id: string;
  from_state: string | null;
  to_state: string;
  cause: string;
  actor: string;
  evidence: ColumnType<unknown, string | null | undefined, never>;
  created_at: Timestamp;
}

export type BatchStatus = "building" | "submitted" | "final_ok" | "final_failed" | "split";

export interface RelayBatchesTable {
  id: string;
  livemode: boolean;
  relayer_key: string;
  size: number;
  gas_attached: BigCol;
  tx_hash: Opt<string>;
  tx_nonce: OptBig;
  status: BatchStatus;
  failure: Opt<string>;
  gas_burnt: OptBig;
  submitted_at: OptTimestamp;
  created_at: Timestamp;
  finalized_at: OptTimestamp;
}

export type RelayerKeyStatus = "active" | "draining" | "retired";

export interface RelayerKeysTable {
  public_key: string;
  account_id: string;
  status: RelayerKeyStatus;
  in_flight: Def<boolean>;
  last_nonce: OptBig;
  allowance_yocto: OptNum;
  allowance_checked_at: OptTimestamp;
  last_used_at: OptTimestamp;
  created_at: Timestamp;
}

export interface QuotasTable {
  account_id: string;
  rps: Def<number>;
  daily_count_limit: Opt<number>;
}

export interface KillSwitchTable {
  id: number;
  engaged: boolean;
  reason: string;
  actor: string;
  event_version: number;
  updated_at: Timestamp;
}

export interface DB extends KitTables {
  issued_requirements: IssuedRequirementsTable;
  checkout_requirements: CheckoutRequirementsTable;
  agent_payments: AgentPaymentsTable;
  agent_payment_transitions: AgentPaymentTransitionsTable;
  relay_batches: RelayBatchesTable;
  relayer_keys: RelayerKeysTable;
  quotas: QuotasTable;
  kill_switch: KillSwitchTable;
  x402_operations: X402OperationsTable;
}
