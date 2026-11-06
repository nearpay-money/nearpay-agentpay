/**
 * A fake NEAR JSON-RPC provider on 127.0.0.1 (tests never touch mainnet): `query` (simulate_intents,
 * current_salt, view_access_key), `send_tx`, `EXPERIMENTAL_tx_status` and `block`, answering in the
 * shapes mainnet providers use (fixtures in the comments). `execute_intents` runs on a FakeVerifier.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeSignedTransaction, encodeTransaction } from "@near-js/transactions";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { executedLog, FakeVerifier, Rejection } from "./verifier.js";

export type SendMode = "ok" | "timeout" | "invalid_nonce";

export interface FakeRpc {
  readonly url: string;
  readonly verifier: FakeVerifier;
  /** Next `send_tx` answers (consumed in order; default "ok"). */
  sendModes: SendMode[];
  readonly sent: {
    hash: string;
    nonce: bigint;
    signer: string;
    publicKey: string;
    gas: bigint;
    deposit: bigint;
    signed: unknown[];
  }[];
  readonly methods: string[];
  stop(): Promise<void>;
}

const enc = new TextEncoder();
const bytesOf = (v: unknown) => Array.from(enc.encode(JSON.stringify(v)));

export async function startFakeRpc(verifier = new FakeVerifier()): Promise<FakeRpc> {
  const outcomes = new Map<string, unknown>();
  let akNonce = 1000n;
  const height = { value: 180_000_000 };
  const blockHash = bs58.encode(sha256(enc.encode("block")));
  const rpc: FakeRpc = {
    url: "",
    verifier,
    sendModes: [],
    sent: [],
    methods: [],
    stop: async () => {},
  };

  function outcome(hash: string, logs: string[], failure: string | null) {
    const status = failure
      ? {
          Failure: {
            ActionError: {
              index: 0,
              kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${failure}` } },
            },
          },
        }
      : { SuccessValue: "" };
    return {
      final_execution_status: "FINAL",
      status,
      transaction: { hash },
      transaction_outcome: { block_hash: blockHash, id: hash, outcome: { gas_burnt: 2_428_000_000_000, logs: [] } },
      receipts_outcome: [
        {
          block_hash: blockHash,
          outcome: {
            gas_burnt: 9_000_000_000_000,
            logs,
            status: failure ? { Failure: (status as { Failure: unknown }).Failure } : { SuccessValue: "" },
          },
        },
      ],
    };
  }

  function handle(method: string, params: Record<string, unknown>): { result?: unknown; error?: unknown } {
    rpc.methods.push(
      method === "query" ? `query:${String(params.request_type)}:${String(params.method_name ?? "")}` : method,
    );
    if (method === "query" && params.request_type === "view_access_key")
      return {
        result: {
          nonce: Number(akNonce),
          block_hash: blockHash,
          block_height: height.value,
          permission: {
            FunctionCall: {
              allowance: "900000000000000000000000",
              receiver_id: "intents.near",
              method_names: ["execute_intents"],
            },
          },
        },
      };
    if (method === "query" && params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(String(params.args_base64), "base64").toString("utf8")) as {
        signed?: unknown[];
      };
      if (params.method_name === "current_salt") return { result: { result: bytesOf("5a0dbe11"), logs: [] } };
      if (params.method_name === "simulate_intents") {
        try {
          const executed = verifier.run(args.signed ?? [], false);
          return {
            result: {
              result: bytesOf({
                intents_executed: executed,
                logs: [executedLog(executed)],
                min_deadline: new Date().toISOString(),
                state: { fee: 0, current_salt: "5a0dbe11" },
              }),
              logs: [],
            },
          };
        } catch (e) {
          // mainnet: {"result":{"error":"wasm execution failed with error: FunctionCallError(HostError(GuestPanic { panic_msg: \"…\" }))"}}
          return {
            result: {
              error: `wasm execution failed with error: FunctionCallError(HostError(GuestPanic { panic_msg: "${(e as Error).message}" }))`,
              logs: [],
            },
          };
        }
      }
    }
    if (method === "send_tx") {
      const st = decodeSignedTransaction(Buffer.from(String(params.signed_tx_base64), "base64"));
      const tx = st.transaction;
      const hash = bs58.encode(sha256(encodeTransaction(tx)));
      const fc = tx.actions[0]?.functionCall;
      const signed = (JSON.parse(Buffer.from(fc?.args ?? []).toString("utf8")) as { signed: unknown[] }).signed;
      const mode = rpc.sendModes.shift() ?? "ok";
      if (mode === "invalid_nonce")
        return {
          error: {
            name: "HANDLER_ERROR",
            cause: { name: "INVALID_TRANSACTION", info: {} },
            data: {
              TxExecutionError: {
                InvalidTxError: { InvalidNonce: { tx_nonce: Number(tx.nonce), ak_nonce: Number(akNonce) } },
              },
            },
          },
        };
      rpc.sent.push({
        hash,
        nonce: BigInt(tx.nonce),
        signer: tx.signerId,
        publicKey: `ed25519:${bs58.encode(Uint8Array.from((tx.publicKey as unknown as { ed25519Key: { data: number[] } }).ed25519Key.data))}`,
        gas: BigInt(fc?.gas ?? 0),
        deposit: BigInt(fc?.deposit ?? 0),
        signed,
      });
      akNonce = BigInt(tx.nonce);
      let out: unknown;
      try {
        const injected = verifier.failExecute?.(signed) ?? null;
        if (injected) throw new Rejection("invalid", injected);
        const executed = verifier.run(signed, true);
        out = outcome(hash, [executedLog(executed)], null);
      } catch (e) {
        out = outcome(hash, [], (e as Error).message);
      }
      outcomes.set(hash, out);
      height.value++;
      if (mode === "timeout") return { error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR", info: {} } } };
      return { result: out };
    }
    if (method === "EXPERIMENTAL_tx_status") {
      const out = outcomes.get(String(params.tx_hash));
      return out
        ? { result: out }
        : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} } } };
    }
    if (method === "block") return { result: { header: { height: height.value, hash: params.block_id } } };
    return { error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "METHOD_NOT_FOUND" } } };
  }

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const r = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
      let answer: { result?: unknown; error?: unknown };
      try {
        answer = handle(r.method, r.params);
      } catch (e) {
        answer = { error: { name: "INTERNAL_ERROR", message: (e as Error).message } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, ...answer }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(rpc, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  });
  return rpc;
}
