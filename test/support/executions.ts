/** A rails `Execution` owned by agentpay (cross-chain x402 quote), as the spec 0.3.0 view carries it. */
import type { Execution } from "@nearpay-internal/spec";
import { execution, USDC_NEAR } from "@nearpay-internal/testing";

export const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const REFUND_TO = "0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317";
export const DEPOSIT = "0x76b4c56085ED136a8744D52bE956396624a730E8";
export const ORIGIN_TX = "0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a";
export const DELIVERY_TX = "9gnJ1EoQy3yqCDqGKiCGJm6YrwTqwYbL1n9vFhJ3nWVd";

export interface QuoteExecutionOptions {
  account: `acct_${string}`;
  livemode?: boolean;
  binding: string;
  payTo: string;
  amount: string;
  refundTo?: string;
  network?: string;
  originAsset?: string;
  depositAddress?: string;
  depositMemo?: string | null;
  deadline?: string;
}

/** An `awaiting_deposit` route execution for a near-intents quote. */
export function quoteExecution(o: QuoteExecutionOptions): Execution {
  const network = o.network ?? "eip155:8453";
  return execution({
    account_id: o.account,
    livemode: o.livemode ?? false,
    kind: "payment",
    method: "route_quote",
    provider: o.livemode ? "oneclick" : "sandbox",
    state: "awaiting_deposit",
    provider_status: "PENDING_DEPOSIT",
    route_class: "stable_pair",
    applied_fee_bps: 50,
    origin: {
      asset_id: o.originAsset ?? BASE_USDC,
      chain: network,
      refund_to: o.refundTo ?? REFUND_TO,
      refund_type: "origin_chain",
    },
    settlement: {
      asset_id: USDC_NEAR,
      amount_base: o.amount,
      tag: "0",
      expected: o.amount,
      recipient: o.payTo,
      recipient_type: "intents",
      chain: "near:mainnet",
    },
    deposit: {
      address: o.depositAddress ?? DEPOSIT,
      memo: o.depositMemo ?? null,
      amount_in: "1012000",
      min_amount_in: "1007000",
      chain: network,
      deadline: o.deadline ?? new Date(Date.now() + 1_800_000).toISOString(),
    },
    intents_requirement: null,
    deposit_tx_hashes: [],
    settled_amount: null,
    refunded_amount: null,
    refund_reason: null,
    evidence: null,
    deadline: o.deadline ?? new Date(Math.floor((Date.now() + 1_800_000) / 1000) * 1000).toISOString(),
    owner: "agentpay",
    x402_binding: o.binding,
    observed_fee: null,
    deposited_amount: null,
  } as never) as Execution;
}

/** The same execution after 1Click delivered `amount` (+ `tag`) and rails accepted evidence from `sender`. */
export function settledExecution(
  x: Execution,
  o: { sender?: string | null; settled?: string; txHashes?: string[] } = {},
): Execution {
  return {
    ...x,
    version: x.version + 3,
    state: "succeeded",
    provider_status: "SUCCESS",
    deposit_tx_hashes: o.txHashes ?? [ORIGIN_TX],
    deposited_amount: "1012000",
    settled_amount: o.settled ?? x.settlement.expected,
    observed_fee: { amount: "5000", asset_id: x.origin.asset_id },
    evidence: {
      chain: "near:mainnet",
      tx_hash: DELIVERY_TX,
      block_ref: "180000123",
      recipient: x.settlement.recipient,
      asset_id: x.settlement.asset_id,
      amount: o.settled ?? x.settlement.expected,
      finality: "final",
      tier: "A",
      source: "indexer",
      observed_at: new Date().toISOString(),
      explorer_url: null,
      sender: o.sender === undefined ? "solver.near" : o.sender,
    },
    terminal_at: new Date().toISOString(),
  } as Execution;
}

export function refundedExecution(x: Execution, reason: string | null = "deposit refunded"): Execution {
  return {
    ...x,
    version: x.version + 2,
    state: "refunded",
    provider_status: "REFUNDED",
    deposit_tx_hashes: [ORIGIN_TX],
    deposited_amount: "900000",
    refunded_amount: "900000",
    refund_reason: reason,
    terminal_at: new Date().toISOString(),
  } as Execution;
}

export function failedExecution(x: Execution): Execution {
  return {
    ...x,
    version: x.version + 1,
    state: "failed",
    provider_status: "FAILED",
    failure_code: "quote_rejected",
    terminal_at: new Date().toISOString(),
  } as Execution;
}
