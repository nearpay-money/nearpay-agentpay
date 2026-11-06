/**
 * Live NEAR access for the facilitator (lld/agentpay.md §6 step 4, §7, §9). Simulation, nonce salt and
 * the signed relayer transaction come from `@nearpay-internal/intents`; submission and final status are
 * plain JSON-RPC here because the batcher records the transaction hash *before* sending (a timed-out
 * `send_tx` must stay traceable: the transaction may still execute, INV-3).
 *
 * | Call                     | Timeout |
 * |--------------------------|---------|
 * | simulate_intents (view)  | 3 s     |
 * | send_tx (wait FINAL)     | 10 s    |
 * | EXPERIMENTAL_tx_status   | 3 s     |
 * | view_access_key, block   | 3 s     |
 */
import type { MultiPayload } from "@nearpay/spec";
import {
  classifyVerifierError,
  type IntentExecuted,
  intentsExecuted,
  intentsRpc,
  RpcError,
  type SimulateIntentsOutput,
  toBase64,
  VerifierError,
} from "@nearpay-internal/intents";

export { RpcError, VerifierError };

export interface TxOutcome {
  readonly txHash: string;
  readonly status: "success" | "failure";
  readonly failure: string | null;
  readonly logs: readonly string[];
  readonly executed: readonly IntentExecuted[];
  readonly gasBurnt: bigint;
  readonly blockHash: string | null;
}

/** The transaction was rejected before execution (bad nonce, expired block hash…): nothing ran. */
export class TxRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxRejected";
  }
}

export interface Relayer {
  readonly accountId: string;
  readonly secretKey: string;
}

export interface NearChain {
  simulate(signed: readonly MultiPayload[]): Promise<SimulateIntentsOutput>;
  /** Signs `execute_intents(signed)` with a function-call key; nothing is sent yet. */
  buildExecute(
    signed: readonly MultiPayload[],
    relayer: Relayer,
    gas: bigint,
    nonce?: bigint,
  ): Promise<{ txHash: string; bytes: Uint8Array; nonce: bigint }>;
  /** `send_tx` waiting for finality; throws RpcError on transport failure/timeout, TxRejected when invalid. */
  send(bytes: Uint8Array, txHash: string): Promise<TxOutcome>;
  /** Final status; null while the transaction is unknown or not final. */
  status(txHash: string, senderId: string): Promise<TxOutcome | null>;
  blockHeight(blockHash: string): Promise<number | null>;
  /** Remaining allowance of a function-call key (yoctoNEAR), null for unlimited/unknown. */
  allowance(accountId: string, publicKey: string): Promise<bigint | null>;
}

interface FinalOutcome {
  status?: { SuccessValue?: string; Failure?: unknown };
  final_execution_status?: string;
  transaction_outcome?: { block_hash?: string; outcome: { gas_burnt: number | string; logs: string[] } };
  receipts_outcome?: { outcome: { gas_burnt: number | string; logs: string[]; status: { Failure?: unknown } } }[];
}

export function summarize(txHash: string, o: FinalOutcome): TxOutcome {
  const receipts = o.receipts_outcome ?? [];
  const logs = [...(o.transaction_outcome?.outcome.logs ?? []), ...receipts.flatMap((r) => r.outcome.logs)];
  const receiptFailure = receipts.find((r) => r.outcome.status.Failure !== undefined)?.outcome.status.Failure;
  const failure = o.status?.Failure ?? receiptFailure;
  const gasBurnt = [...(o.transaction_outcome ? [o.transaction_outcome] : []), ...receipts].reduce(
    (g, r) => g + BigInt(r.outcome.gas_burnt),
    0n,
  );
  return {
    txHash,
    status: failure !== undefined ? "failure" : "success",
    failure: failure !== undefined ? JSON.stringify(failure) : null,
    logs,
    executed: intentsExecuted(logs),
    gasBurnt,
    blockHash: o.transaction_outcome?.block_hash ?? null,
  };
}

/** The Verifier rejection of a failed transaction ("Smart contract panicked: …"), classified like a simulation. */
export function failureReason(failure: string | null): ReturnType<typeof classifyVerifierError> {
  return classifyVerifierError(failure ?? "");
}

export function nearChain(o: { rpcUrls: readonly string[]; contract: string; fetch?: typeof fetch }): NearChain {
  const f = o.fetch ?? fetch;
  const kit = intentsRpc({
    rpcUrls: o.rpcUrls,
    contract: o.contract,
    timeoutMs: 3_000,
    ...(o.fetch ? { fetch: f } : {}),
  });
  let id = 0;

  /** JSON-RPC across providers; a JSON-RPC error from one provider is returned (not retried elsewhere). */
  async function call(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<{ result?: unknown; error?: unknown }> {
    const errors: string[] = [];
    for (const url of o.rpcUrls) {
      try {
        const res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { result?: unknown; error?: unknown };
      } catch (e) {
        errors.push(`${new URL(url).host}: ${(e as Error).message}`);
      }
    }
    throw new RpcError(`all RPC providers failed for ${method}`, errors);
  }

  const errorText = (e: unknown) => JSON.stringify(e ?? null);

  return {
    simulate: (signed) => kit.simulateIntents(signed),
    buildExecute: (signed, relayer, gas, nonce) =>
      kit.buildExecuteTx(signed, { accountId: relayer.accountId, secretKey: relayer.secretKey }, gas, nonce),

    async send(bytes, txHash) {
      const r = await call("send_tx", { signed_tx_base64: toBase64(bytes), wait_until: "FINAL" }, 10_000);
      if (r.error !== undefined) {
        const text = errorText(r.error);
        // An invalid transaction never executes; a timeout/unknown status must be polled.
        if (/InvalidTxError|InvalidNonce|Expired|InvalidSignature|NotEnoughBalance|NotEnoughAllowance/.test(text))
          throw new TxRejected(text.slice(0, 500));
        throw new RpcError(`send_tx: ${text.slice(0, 300)}`);
      }
      return summarize(txHash, r.result as FinalOutcome);
    },

    async status(txHash, senderId) {
      const r = await call(
        "EXPERIMENTAL_tx_status",
        { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" },
        3_000,
      );
      if (r.error !== undefined) {
        const text = errorText(r.error);
        if (/UNKNOWN_TRANSACTION|TIMEOUT_ERROR|Timeout/i.test(text)) return null;
        throw new RpcError(`tx_status: ${text.slice(0, 300)}`);
      }
      const out = r.result as FinalOutcome;
      if (!out?.status) return null;
      return summarize(txHash, out);
    },

    async blockHeight(blockHash) {
      const r = await call("block", { block_id: blockHash }, 3_000);
      const h = (r.result as { header?: { height?: number } } | undefined)?.header?.height;
      return typeof h === "number" ? h : null;
    },

    async allowance(accountId, publicKey) {
      const r = await call(
        "query",
        { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
        3_000,
      );
      const p = (r.result as { permission?: unknown } | undefined)?.permission as
        | { FunctionCall?: { allowance?: string | null } }
        | string
        | undefined;
      if (typeof p === "object" && p?.FunctionCall?.allowance) return BigInt(p.FunctionCall.allowance);
      return null;
    },
  };
}
