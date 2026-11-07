/** `send_tx` through kit `sendSignedTx` (CR-15-16): only a unanimous invalid-transaction answer is a rejection. */
import { RpcError, VerifierError } from "@nearpay-internal/intents";
import { describe, expect, it } from "vitest";
import { fromExecuteResult, sendFailure, TxRejected } from "../../src/infra/near/rpc.js";

describe("sendFailure", () => {
  it("is a rejection only when every provider refused the transaction as invalid", () => {
    const nonce = 'a.example: JSON-RPC error: {"data":{"TxExecutionError":{"InvalidTxError":{"InvalidNonce":{}}}}}';
    expect(sendFailure(new RpcError("all RPC providers failed for send_tx", [nonce, nonce]))).toBeInstanceOf(
      TxRejected,
    );
    // one provider timed out: the transaction may still land, poll it (INV-3)
    const mixed = sendFailure(
      new RpcError("all failed", [nonce, "b.example: The operation was aborted due to timeout"]),
    );
    expect(mixed).toBeInstanceOf(RpcError);
    expect(mixed).not.toBeInstanceOf(TxRejected);
    expect(sendFailure(new RpcError("send_tx returned outcome of X, expected Y"))).toBeInstanceOf(RpcError);
    expect(sendFailure(new VerifierError("invalid_payload", "panic"))).toBeInstanceOf(RpcError);
    expect(sendFailure("boom")).toBeInstanceOf(RpcError);
  });

  it("maps kit outcomes, keeping the block hash when the RPC returns it", () => {
    const r = { txHash: "h", status: "success" as const, failure: null, logs: [], intentsExecuted: [], gasBurnt: 1n };
    expect(fromExecuteResult(r).blockHash).toBeNull();
    expect(fromExecuteResult({ ...r, blockHash: "b" })).toMatchObject({ txHash: "h", blockHash: "b", executed: [] });
  });
});
