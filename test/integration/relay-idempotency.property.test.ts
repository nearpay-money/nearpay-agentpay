/**
 * Property test (real service, Postgres, batcher): refund relays are idempotent on the payload hash
 * (lld/agentpay.md §5, §7; INV-4). For any interleaving of replays, concurrent submissions and
 * non-issued variants over a few refund legs:
 *   - every submission of a leg's issued payload answers the same agent payment;
 *   - non-issued variants are refused and leave no trace;
 *   - each leg has at most one agent payment and one `queued` transition, and after relaying the
 *     payer received the leg amount exactly once (never a second relay).
 */
import type { IntentMessage } from "@nearpay/spec";
import { mintServiceToken } from "@nearpay-internal/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Signer, signer } from "../support/refund.js";
import { type Merchant, type RefundLeg, type Stack, startStack, USDC_NEAR, uuid } from "../support/stack.js";

let s: Stack;
let m: Merchant;
beforeAll(async () => {
  s = await startStack({ autoBatch: false });
  m = s.merchant();
});
afterAll(async () => {
  await s?.stop();
});

const relay = async (body: unknown) =>
  s.call("POST", "/internal/relay", { token: await mintServiceToken("payments"), body });

type Op = { leg: number; variant: "issued" | "amount" | "nonce-order"; concurrent: number };

const opArb = fc.record({
  leg: fc.integer({ min: 0, max: 2 }),
  variant: fc.constantFrom<Op["variant"]>("issued", "issued", "amount", "nonce-order"),
  concurrent: fc.integer({ min: 1, max: 4 }),
});

function variant(k: Signer, l: RefundLeg, v: Op["variant"]) {
  if (v === "issued") return k.sign(l.message);
  const x = structuredClone(l.message) as IntentMessage;
  const t = x.intents[0] as Record<string, unknown>;
  if (v === "amount") t.tokens = { [USDC_NEAR]: (BigInt(l.transfer.amount) + 1n).toString() };
  else x.intents = [{ memo: t.memo, receiver_id: t.receiver_id, tokens: t.tokens, intent: t.intent } as never];
  return k.sign(x);
}

describe("refund relay idempotency (property)", () => {
  it("one agent payment and one relay per leg, whatever the submissions", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 8 }), async (ops) => {
        const k = signer();
        s.testVerifier.fund(k.account, USDC_NEAR, 100_000_000n);
        const legs = [0, 1, 2].map(() => s.refundLeg(m, k));
        const ids = new Map<number, Set<string>>();
        for (const op of ops) {
          const l = legs[op.leg] as RefundLeg;
          const signed = variant(k, l, op.variant);
          const body = {
            execution_id: l.execution.id,
            binding: l.transfer.memo,
            signed,
            kind: "refund",
            refund: l.refund,
          };
          const res = await Promise.all(Array.from({ length: op.concurrent }, () => relay(body)));
          for (const r of res) {
            if (op.variant === "issued") {
              expect(r.status, JSON.stringify(r.body)).toBe(202);
              const set = ids.get(op.leg) ?? new Set<string>();
              set.add(r.body.agent_payment_id);
              ids.set(op.leg, set);
            } else expect([r.status, r.body.error?.code]).toEqual([422, "signed_intent_mismatch"]);
          }
        }
        await s.tick();
        for (const [i, l] of legs.entries()) {
          const rows = await s.admin.db
            .selectFrom("agent_payments")
            .select(["id", "status"])
            .where("refund_id", "=", uuid(l.refund, "re"))
            .execute();
          const seen = ids.get(i);
          if (!seen) {
            expect(rows).toEqual([]);
            expect(s.testVerifier.balance(l.transfer.receiver_id, USDC_NEAR)).toBe(0n);
            continue;
          }
          expect(seen.size).toBe(1);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.id).toBe(uuid([...seen][0] as string, "ap"));
          const queued = await s.admin.db
            .selectFrom("agent_payment_transitions")
            .select("id")
            .where("agent_payment_id", "=", rows[0]?.id as string)
            .where("from_state", "is", null)
            .execute();
          expect(queued).toHaveLength(1);
          // relayed at most once: the payer holds the leg amount exactly (or nothing yet)
          const got = s.testVerifier.balance(l.transfer.receiver_id, USDC_NEAR);
          expect([0n, BigInt(l.transfer.amount)]).toContain(got);
          // a replay after relaying answers the same agent payment and relays nothing more
          const again = await relay({
            execution_id: l.execution.id,
            binding: l.transfer.memo,
            signed: k.sign(l.message),
            kind: "refund",
            refund: l.refund,
          });
          expect(again.body.agent_payment_id).toBe([...seen][0]);
          await s.tick();
          expect(s.testVerifier.balance(l.transfer.receiver_id, USDC_NEAR)).toBe(BigInt(l.transfer.amount));
        }
      }),
      { numRuns: 12 },
    );
  });
});
