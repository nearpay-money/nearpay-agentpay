/**
 * The batching relayer (lld/agentpay.md §7), run by the elected leader of `agentpay-batcher`.
 *
 * Every tick (150 ms), per mode:
 *   claim   queued payloads (oldest first, `for update skip locked`) → fail the ones whose deadline has
 *           passed → take a batch (a `solo` payload alone) → claim a free relayer key (live) → the batch
 *           row (`building`) and its payloads `submitted`, in one transaction;
 *   check   `simulate_intents` on the batch; on rejection re-simulate each payload, fail the rejected
 *           ones (reason from the Verifier) and keep the rest;
 *   send    live: sign `execute_intents(signed)` with the key (function call, zero deposit, gas
 *           `n × GAS_PER_PAYLOAD + 20 Tgas`), record the hash, `send_tx(wait_until=FINAL)`; test: the
 *           sandbox Verifier `/sim/intents/execute` (INV-8);
 *   apply   success → payloads listed in `intents_executed` (signer, nonce) are `settled`; failure → a
 *           multi-payload batch is `split` and its payloads requeued alone, a single payload `failed`;
 *           a `send_tx` timeout leaves the batch `submitted` and its status is polled every 2 s (30 s
 *           after the first minute) until final — never failed blindly (INV-3).
 * Final x402 payments emit `evt.agentpay.agent_payment.*` (ledger) and wake settle waiters (`ap:<id>`).
 * Relayer keys only call `execute_intents` with zero deposit: the payload executes exactly as signed (INV-1).
 */
import type { MultiPayload } from "@nearpay/spec";
import { uuidv7 } from "@nearpay-internal/ids";
import type { Agentpay } from "../../app/context.js";
import { updatePayment } from "../../app/ledger.js";
import { simulate, VerifierUnavailable } from "../../app/verifier.js";
import type { AgentPaymentRow } from "../../app/views.js";
import { batchGas, maxBatch, selectBatch, tooLate } from "../../domain/relay-batch/batch.js";
import { failureReason, TxRejected } from "../../infra/near/rpc.js";
import { claimKey, LOW_ALLOWANCE_YOCTO, type RelayerKey, releaseKey } from "../key-pool/keys.js";
import { type ExecutedWithHash, matchExecutedWithHashes } from "./outcome.js";

export interface BatcherOptions {
  /** Loaded relayer keys by public key (live mode). */
  readonly keys: ReadonlyMap<string, RelayerKey>;
  readonly relayerAccount: string | null;
}

interface Claim {
  readonly batchId: string;
  readonly livemode: boolean;
  readonly key: { publicKey: string; lastNonce: bigint | null };
  readonly rows: AgentPaymentRow[];
}

export interface Outcome {
  readonly txHash: string;
  readonly status: "success" | "failure";
  readonly failure: string | null;
  readonly executed: readonly ExecutedWithHash[];
  readonly gasBurnt: bigint | null;
  readonly blockHeight: number | null;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PAUSE_MS = 2_000;
const POLL_FAST_MS = 2_000;
const POLL_SLOW_MS = 30_000;
const POLL_FAST_WINDOW_MS = 60_000;
/** NEAR transactions reference a block hash valid for about a day (86 400 blocks). */
const NEVER_LANDED_MS = 25 * 3_600_000;

export function batcher(ap: Agentpay, o: BatcherOptions) {
  const max = maxBatch(ap.settings.gasPerPayloadTgas);
  const inflight = new Set<Promise<void>>();
  const pausedUntil = new Map<boolean, number>();
  const lastPoll = new Map<string, number>();
  const alerted = new Set<string>();
  let testBusy = false;

  const liveReady = () => ap.chain !== null && o.keys.size > 0 && o.relayerAccount !== null;
  const modeReady = (lm: boolean) => (lm ? liveReady() : ap.sandbox !== null);

  async function publishFinal(ids: readonly string[]) {
    for (const id of ids) await ap.waiters.publish(id);
  }

  /** Claims the next batch of a mode (or fails expired payloads); null when there is nothing to do. */
  async function claim(lm: boolean): Promise<Claim | null> {
    const finals: string[] = [];
    const c = await ap.db.transaction().execute(async (tx) => {
      const rows = await tx
        .selectFrom("agent_payments")
        .selectAll()
        .where("status", "=", "queued")
        .where("livemode", "=", lm)
        .orderBy("created_at")
        .orderBy("id")
        .limit(max + 16)
        .forUpdate()
        .skipLocked()
        .execute();
      const usable: AgentPaymentRow[] = [];
      for (const r of rows) {
        if (tooLate(r.deadline, ap.now())) {
          await updatePayment(
            tx,
            r,
            { status: "failed", error_reason: "deadline_invalid" },
            { cause: "payload deadline passed before relay", actor: "batcher" },
          );
          finals.push(r.id);
        } else usable.push(r);
      }
      const batch = selectBatch(usable, max);
      if (batch.length === 0) return null;
      const key = lm ? await claimKey(tx, [...o.keys.keys()]) : { publicKey: "sandbox", lastNonce: null };
      if (!key) return null;
      const batchId = uuidv7();
      await tx
        .insertInto("relay_batches")
        .values({
          id: batchId,
          livemode: lm,
          relayer_key: key.publicKey,
          size: batch.length,
          gas_attached: batchGas(batch.length, ap.settings.gasPerPayloadTgas).toString(),
          status: "building",
        })
        .execute();
      const claimed: AgentPaymentRow[] = [];
      for (const r of batch)
        claimed.push(
          await updatePayment(
            tx,
            r,
            { status: "submitted", batch_id: batchId, tx_hash: null },
            { cause: `relay batch ${batchId}`, actor: "batcher" },
          ),
        );
      return { batchId, livemode: lm, key, rows: claimed };
    });
    await publishFinal(finals);
    return c;
  }

  /** Nothing was sent: payloads go back to the queue, the batch is closed as `split`. */
  async function abandon(c: Claim, reason: string): Promise<void> {
    await ap.db.transaction().execute(async (tx) => {
      const rows = await tx
        .selectFrom("agent_payments")
        .selectAll()
        .where("batch_id", "=", c.batchId)
        .where("status", "=", "submitted")
        .forUpdate()
        .execute();
      for (const r of rows)
        await updatePayment(
          tx,
          r,
          { status: "queued", batch_id: null, tx_hash: null },
          { cause: `batch abandoned: ${reason}`, actor: "batcher" },
        );
      await tx
        .updateTable("relay_batches")
        .set({ status: "split", failure: reason.slice(0, 500), finalized_at: new Date() })
        .where("id", "=", c.batchId)
        .execute();
    });
    await releaseKey(ap.db, c.key.publicKey, undefined);
    pausedUntil.set(c.livemode, ap.now() + PAUSE_MS);
    ap.log.warn({ batch: c.batchId, reason }, "relay batch abandoned; payloads requeued");
  }

  /** §7 "re-simulate each": fails the payloads the Verifier rejects, keeps the rest. */
  async function prune(c: Claim): Promise<AgentPaymentRow[] | null> {
    const keep: AgentPaymentRow[] = [];
    const finals: string[] = [];
    for (const r of c.rows) {
      let s: Awaited<ReturnType<typeof simulate>>;
      try {
        s = await simulate(ap, c.livemode, [r.payload as MultiPayload]);
      } catch (e) {
        if (e instanceof VerifierUnavailable) return null;
        throw e;
      }
      if (s.ok) {
        keep.push(r);
        continue;
      }
      await ap.db.transaction().execute(async (tx) => {
        const cur = await tx
          .selectFrom("agent_payments")
          .selectAll()
          .where("id", "=", r.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await updatePayment(
          tx,
          cur,
          { status: "failed", error_reason: s.reason, batch_id: null },
          { cause: `Verifier rejected the payload: ${s.detail}`, actor: "batcher" },
        );
      });
      finals.push(r.id);
    }
    await publishFinal(finals);
    return keep;
  }

  /** Applies a final transaction outcome to a batch (idempotent: only `building`/`submitted` batches). */
  async function applyOutcome(batchId: string, out: Outcome, keyNonce: bigint | null | undefined): Promise<void> {
    const finals: string[] = [];
    const key = await ap.db.transaction().execute(async (tx) => {
      const b = await tx
        .selectFrom("relay_batches")
        .selectAll()
        .where("id", "=", batchId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (b.status !== "building" && b.status !== "submitted") return null;
      const rows = await tx
        .selectFrom("agent_payments")
        .selectAll()
        .where("batch_id", "=", batchId)
        .where("status", "=", "submitted")
        .forUpdate()
        .execute();
      const now = new Date(ap.now());
      const evidence = { tx_hash: out.txHash, block_height: out.blockHeight, batch: batchId };
      if (out.status === "success") {
        const { settled, missing } = matchExecutedWithHashes(rows, out.executed);
        for (const { row, intentHash } of settled) {
          await updatePayment(
            tx,
            row,
            {
              status: "settled",
              tx_hash: out.txHash,
              block_height: out.blockHeight,
              settled_at: now,
              intent_hashes: intentHash ? [intentHash] : null,
            },
            { cause: "execute_intents final", actor: "batcher", evidence },
          );
          finals.push(row.id);
        }
        for (const row of missing)
          await updatePayment(
            tx,
            row,
            { status: "queued", solo: true, batch_id: null, tx_hash: null },
            { cause: "transaction final without this payload in intents_executed", actor: "batcher", evidence },
          );
        await tx
          .updateTable("relay_batches")
          .set({
            status: "final_ok",
            tx_hash: out.txHash,
            gas_burnt: out.gasBurnt?.toString() ?? null,
            finalized_at: now,
          })
          .where("id", "=", batchId)
          .execute();
      } else {
        ap.metrics.batchFailure();
        const reason = failureReason(out.failure);
        if (rows.length > 1) {
          for (const row of rows)
            await updatePayment(
              tx,
              row,
              { status: "queued", solo: true, batch_id: null, tx_hash: null },
              {
                cause: `batch failed on chain, retrying alone: ${out.failure ?? "unknown"}`,
                actor: "batcher",
                evidence,
              },
            );
        } else {
          for (const row of rows) {
            await updatePayment(
              tx,
              row,
              { status: "failed", error_reason: reason, tx_hash: out.txHash, block_height: out.blockHeight },
              { cause: `execute_intents failed: ${out.failure ?? "unknown"}`, actor: "batcher", evidence },
            );
            finals.push(row.id);
          }
        }
        await tx
          .updateTable("relay_batches")
          .set({
            status: rows.length > 1 ? "split" : "final_failed",
            tx_hash: out.txHash,
            failure: (out.failure ?? "unknown").slice(0, 500),
            gas_burnt: out.gasBurnt?.toString() ?? null,
            finalized_at: now,
          })
          .where("id", "=", batchId)
          .execute();
      }
      return b.relayer_key;
    });
    if (key) await releaseKey(ap.db, key, keyNonce);
    await publishFinal(finals);
  }

  async function recordSubmitted(c: Claim, rows: AgentPaymentRow[], txHash: string, nonce: bigint | null, gas: bigint) {
    await ap.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("relay_batches")
        .set({
          status: "submitted",
          tx_hash: txHash,
          tx_nonce: nonce === null ? null : nonce.toString(),
          size: rows.length,
          gas_attached: gas.toString(),
          submitted_at: new Date(ap.now()),
        })
        .where("id", "=", c.batchId)
        .execute();
      await tx
        .updateTable("agent_payments")
        // tx_hash is part of the AgentPayment object: a change, so the version (= sequence) moves too
        .set((eb) => ({ tx_hash: txHash, version: eb("version", "+", 1), updated_at: new Date() }))
        .where("batch_id", "=", c.batchId)
        .where("status", "=", "submitted")
        .execute();
    });
  }

  async function sendLive(c: Claim, rows: AgentPaymentRow[]): Promise<void> {
    const chain = ap.chain;
    const secret = o.keys.get(c.key.publicKey);
    if (!chain || !secret || !o.relayerAccount) return abandon(c, "live relaying is not configured");
    const gas = batchGas(rows.length, ap.settings.gasPerPayloadTgas);
    const signed = rows.map((r) => r.payload as MultiPayload);
    let built: Awaited<ReturnType<typeof chain.buildExecute>>;
    try {
      built = await chain.buildExecute(
        signed,
        { accountId: o.relayerAccount, secretKey: secret.secretKey },
        gas,
        c.key.lastNonce !== null ? c.key.lastNonce + 1n : undefined,
      );
    } catch (e) {
      return abandon(c, `could not build the transaction: ${errText(e)}`);
    }
    await recordSubmitted(c, rows, built.txHash, built.nonce, gas);
    ap.metrics.batch(rows.length);
    let tx: Awaited<ReturnType<typeof chain.send>>;
    try {
      tx = await chain.send(built.bytes, built.txHash);
    } catch (e) {
      if (e instanceof TxRejected) {
        // never executed: requeue, and forget the nonce (it was rejected)
        await abandon(c, `transaction rejected: ${e.message}`);
        await releaseKey(ap.db, c.key.publicKey, null);
        return;
      }
      ap.log.warn({ batch: c.batchId, tx: built.txHash, err: errText(e) }, "send_tx unconfirmed; polling the status");
      lastPoll.set(c.batchId, ap.now());
      return;
    }
    const blockHeight = tx.blockHash ? await chain.blockHeight(tx.blockHash).catch(() => null) : null;
    await applyOutcome(
      c.batchId,
      {
        txHash: tx.txHash,
        status: tx.status,
        failure: tx.failure,
        executed: tx.executed,
        gasBurnt: tx.gasBurnt,
        blockHeight,
      },
      built.nonce,
    );
  }

  async function sendTest(c: Claim, rows: AgentPaymentRow[]): Promise<void> {
    const sandbox = ap.sandbox;
    if (!sandbox) return abandon(c, "test mode is not configured");
    ap.metrics.batch(rows.length);
    let r: Awaited<ReturnType<typeof sandbox.execute>>;
    try {
      r = await sandbox.execute(rows.map((x) => x.payload));
    } catch (e) {
      return abandon(c, `sandbox execute failed: ${errText(e)}`);
    }
    await recordSubmitted(c, rows, r.tx_hash, null, batchGas(rows.length, ap.settings.gasPerPayloadTgas));
    await applyOutcome(
      c.batchId,
      {
        txHash: r.tx_hash,
        status: r.status,
        failure: r.failure,
        executed: r.intents_executed,
        gasBurnt: null,
        blockHeight: r.block_height,
      },
      undefined,
    );
  }

  async function process(c: Claim): Promise<void> {
    let rows = c.rows;
    let sim: Awaited<ReturnType<typeof simulate>>;
    try {
      sim = await simulate(
        ap,
        c.livemode,
        rows.map((r) => r.payload as MultiPayload),
      );
    } catch (e) {
      if (e instanceof VerifierUnavailable) return abandon(c, e.message);
      throw e;
    }
    if (!sim.ok) {
      ap.metrics.batchFailure();
      const kept = await prune(c);
      if (kept === null) return abandon(c, "verifier unavailable");
      rows = kept;
      if (rows.length === 0) {
        await ap.db
          .updateTable("relay_batches")
          .set({
            status: "split",
            size: 0,
            failure: "every payload was rejected by simulation",
            finalized_at: new Date(),
          })
          .where("id", "=", c.batchId)
          .execute();
        await releaseKey(ap.db, c.key.publicKey, undefined);
        return;
      }
    }
    return c.livemode ? sendLive(c, rows) : sendTest(c, rows);
  }

  function track(p: Promise<void>, c: Claim) {
    const t = p
      .catch(async (e) => {
        ap.log.error({ batch: c.batchId, err: errText(e) }, "relay batch failed unexpectedly");
        try {
          const b = await ap.db
            .selectFrom("relay_batches")
            .select(["status", "tx_hash"])
            .where("id", "=", c.batchId)
            .executeTakeFirst();
          if (b?.status === "building") await abandon(c, `unexpected error: ${errText(e)}`);
        } catch {
          /* recover() at the next leadership start */
        }
      })
      .finally(() => {
        inflight.delete(t);
        if (!c.livemode) testBusy = false;
      });
    inflight.add(t);
  }

  /** Polls `submitted` live batches whose `send_tx` did not confirm (§7). */
  async function pollSubmitted(): Promise<void> {
    const chain = ap.chain;
    if (!chain || !o.relayerAccount) return;
    const batches = await ap.db
      .selectFrom("relay_batches")
      .selectAll()
      .where("status", "=", "submitted")
      .where("livemode", "=", true)
      .where("tx_hash", "is not", null)
      .execute();
    const now = ap.now();
    for (const b of batches) {
      const age = now - (b.submitted_at?.getTime() ?? now);
      const every = age < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS;
      if ((lastPoll.get(b.id) ?? 0) > now - every) continue;
      lastPoll.set(b.id, now);
      let out: Awaited<ReturnType<typeof chain.status>>;
      try {
        out = await chain.status(b.tx_hash as string, o.relayerAccount);
      } catch (e) {
        ap.log.warn({ batch: b.id, err: errText(e) }, "tx status unavailable");
        continue;
      }
      if (!out) {
        if (age > NEVER_LANDED_MS) {
          // the transaction's block hash has long expired: it can no longer execute
          await abandon(
            { batchId: b.id, livemode: true, key: { publicKey: b.relayer_key, lastNonce: null }, rows: [] },
            "transaction never landed",
          );
          await releaseKey(ap.db, b.relayer_key, null);
          continue;
        }
        if (age > POLL_FAST_WINDOW_MS && !alerted.has(b.id)) {
          alerted.add(b.id);
          ap.log.error({ batch: b.id, tx: b.tx_hash }, "ALERT relay transaction not final after 60 s; still polling");
        }
        continue;
      }
      const blockHeight = out.blockHash ? await chain.blockHeight(out.blockHash).catch(() => null) : null;
      await applyOutcome(
        b.id,
        {
          txHash: out.txHash,
          status: out.status,
          failure: out.failure,
          executed: out.executed,
          gasBurnt: out.gasBurnt,
          blockHeight,
        },
        b.tx_nonce === null ? undefined : BigInt(b.tx_nonce),
      );
      lastPoll.delete(b.id);
      alerted.delete(b.id);
    }
  }

  return {
    /** One scheduling round: poll unconfirmed live batches, then claim batches while keys allow. */
    async tick(): Promise<void> {
      if (liveReady()) await pollSubmitted().catch((e) => ap.log.warn({ err: errText(e) }, "poll failed"));
      for (const lm of [false, true]) {
        if (!modeReady(lm) || (pausedUntil.get(lm) ?? 0) > ap.now()) continue;
        for (let i = 0; i < 8; i++) {
          if (!lm && testBusy) break;
          const c = await claim(lm);
          if (!c) break;
          if (!lm) testBusy = true;
          track(process(c), c);
          if (!lm) break;
        }
      }
    },

    /** Waits for in-flight batches (tests, shutdown). */
    async drain(): Promise<void> {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },

    /**
     * Leadership start: batches still `building` (and test batches left `submitted`) never reached the
     * chain from this process's point of view → requeue; keys without an unconfirmed live batch → free.
     */
    async recover(): Promise<void> {
      const stale = await ap.db
        .selectFrom("relay_batches")
        .selectAll()
        .where((eb) =>
          eb.or([eb("status", "=", "building"), eb.and([eb("status", "=", "submitted"), eb("livemode", "=", false)])]),
        )
        .execute();
      for (const b of stale)
        await abandon(
          { batchId: b.id, livemode: b.livemode, key: { publicKey: b.relayer_key, lastNonce: null }, rows: [] },
          "abandoned at restart",
        );
      pausedUntil.clear();
      const busy = await ap.db
        .selectFrom("relay_batches")
        .select("relayer_key")
        .where("status", "=", "submitted")
        .where("livemode", "=", true)
        .execute();
      let q = ap.db.updateTable("relayer_keys").set({ in_flight: false }).where("in_flight", "=", true);
      if (busy.length)
        q = q.where(
          "public_key",
          "not in",
          busy.map((b) => b.relayer_key),
        );
      await q.execute();
    },

    /** Allowance monitor (§9, RB-09): gauge per key, alert below 20% of the 5 NEAR allowance. */
    async checkAllowances(): Promise<void> {
      const chain = ap.chain;
      if (!chain || !o.relayerAccount) return;
      for (const k of o.keys.values()) {
        try {
          const a = await chain.allowance(o.relayerAccount, k.publicKey);
          if (a === null) continue;
          await ap.db
            .updateTable("relayer_keys")
            .set({ allowance_yocto: a.toString(), allowance_checked_at: new Date() })
            .where("public_key", "=", k.publicKey)
            .execute();
          ap.metrics.allowance(k.publicKey, Number(a / 10n ** 20n) / 10_000); // gauge only, not money
          if (a < LOW_ALLOWANCE_YOCTO)
            ap.log.error(
              { key: k.publicKey, allowance_yocto: a.toString() },
              "ALERT relayer key allowance below 20% (RB-09)",
            );
        } catch (e) {
          ap.log.warn({ key: k.publicKey, err: errText(e) }, "allowance check failed");
        }
      }
    },
  };
}

export type Batcher = ReturnType<typeof batcher>;
