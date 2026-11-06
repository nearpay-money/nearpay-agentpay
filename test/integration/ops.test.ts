/**
 * Operations: restart recovery of the batcher (§7), relayer key draining (§9), the ops CLI, the
 * requirement purge job and the key file loader.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "@nearpay-internal/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runOps } from "../../src/ops/cli.js";
import { loadKeyFiles, parseKeyFile } from "../../src/relayer/key-pool/keys.js";
import { jobHandlers, REQUIREMENTS_PURGE_JOB } from "../../src/workers/jobs.js";
import { payer } from "../support/payer.js";
import { relayerKey, type Stack, startStack, termsOf, USDC_NEAR, x402Body } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ autoBatch: false, config: { settleWaitMs: 0 } });
});
afterAll(async () => {
  await s?.stop();
});

async function queueLive() {
  const m = s.merchant();
  const p = payer();
  s.rpc.verifier.fund(p.account, USDC_NEAR, 1_000_000n);
  const token = await s.token(m, { livemode: true });
  const req = (
    await s.call("POST", "/x402/requirements", {
      token,
      body: { resource: { url: "https://m.example/a" }, amount: "10000" },
    })
  ).body as { accepts: unknown[] };
  const r = await s.call("POST", "/x402/settle", { token, body: x402Body(req, p.sign(termsOf(req))) });
  expect(r.body.errorReason).toBe("settlement_pending");
  return termsOf(req).binding;
}

async function ops(...argv: string[]) {
  const out: string[] = [];
  const code = await runOps(argv, s.ap, { out: (l) => out.push(l), err: (l) => out.push(l) });
  return { code, out: out.join("\n") };
}

describe("batcher recovery and keys", () => {
  it("requeues a batch left building by a crash and frees its key", async () => {
    const binding = await queueLive();
    const row = await s.admin.db
      .selectFrom("agent_payments")
      .selectAll()
      .where("binding", "=", binding)
      .executeTakeFirstOrThrow();
    const key = s.relayerKeys[0]?.publicKey as string;
    const batchId = uuidv7();
    await s.admin.db
      .insertInto("relay_batches")
      .values({ id: batchId, livemode: true, relayer_key: key, size: 1, gas_attached: "1", status: "building" })
      .execute();
    await s.admin.db
      .updateTable("agent_payments")
      .set({ status: "submitted", batch_id: batchId })
      .where("id", "=", row.id)
      .execute();
    await s.admin.db.updateTable("relayer_keys").set({ in_flight: true }).execute();
    await s.batcher.batcher.recover();
    expect(
      (
        await s.admin.db
          .selectFrom("relay_batches")
          .select("status")
          .where("id", "=", batchId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("split");
    expect(
      (
        await s.admin.db
          .selectFrom("agent_payments")
          .select("status")
          .where("id", "=", row.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("queued");
    expect((await s.admin.db.selectFrom("relayer_keys").select("in_flight").execute()).every((k) => !k.in_flight)).toBe(
      true,
    );
    await s.tick();
    expect(
      (
        await s.admin.db
          .selectFrom("agent_payments")
          .select("status")
          .where("id", "=", row.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("settled");
  });

  it("stops using drained keys and waits when none is free", async () => {
    for (const k of s.relayerKeys) expect((await ops("key-status", k.publicKey, "draining")).code).toBe(0);
    const binding = await queueLive();
    await s.tick();
    expect(
      (
        await s.admin.db
          .selectFrom("agent_payments")
          .select("status")
          .where("binding", "=", binding)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("queued");
    await ops("key-status", s.relayerKeys[1]?.publicKey as string, "active");
    await s.tick();
    expect(
      (
        await s.admin.db
          .selectFrom("agent_payments")
          .select("status")
          .where("binding", "=", binding)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("settled");
    expect(s.rpc.sent.at(-1)?.publicKey).toBe(s.relayerKeys[1]?.publicKey);
    await ops("key-status", s.relayerKeys[0]?.publicKey as string, "active");
  });

  it("checks key allowances", async () => {
    await s.batcher.batcher.checkAllowances();
    const keys = await s.admin.db.selectFrom("relayer_keys").select(["allowance_yocto"]).execute();
    expect(keys.every((k) => k.allowance_yocto === "900000000000000000000000")).toBe(true);
  });
});

describe("ops CLI", () => {
  it("shows payments, the queue, keys and the kill switch", async () => {
    const binding = await queueLive();
    await s.tick();
    const row = await s.admin.db
      .selectFrom("agent_payments")
      .select("id")
      .where("binding", "=", binding)
      .executeTakeFirstOrThrow();
    const { fromUuid } = await import("@nearpay-internal/ids");
    const p = await ops("payment", fromUuid("ap", row.id));
    expect(p.code).toBe(0);
    expect(JSON.parse(p.out)).toMatchObject({ agent_payment: { status: "settled" }, batch: { status: "final_ok" } });
    expect(JSON.parse((await ops("queue")).out).payments.length).toBeGreaterThan(0);
    expect(JSON.parse((await ops("keys")).out).keys).toHaveLength(2);
    expect(JSON.parse((await ops("kill-switch")).out).kill_switch.engaged).toBe(false);
    expect((await ops("nope")).code).toBe(2);
    expect((await ops("payment", "x")).code).toBe(2);
    expect((await ops("key-status", "ed25519:unknown", "active")).code).toBe(1);
  });
});

describe("jobs and key files", () => {
  it("purges long-expired unconsumed requirements", async () => {
    const m = s.merchant();
    const token = await s.token(m);
    const req = (
      await s.call("POST", "/x402/requirements", {
        token,
        body: { resource: { url: "https://m.example/a" }, amount: "10000" },
      })
    ).body as {
      accepts: unknown[];
    };
    const binding = termsOf(req).binding;
    await s.admin.db
      .updateTable("issued_requirements")
      .set({ expires_at: new Date(Date.now() - 2 * 86_400_000) })
      .where("binding", "=", binding)
      .execute();
    await jobHandlers(s.ap, s.batcher.batcher)[REQUIREMENTS_PURGE_JOB]?.({}, {} as never);
    expect(
      await s.admin.db
        .selectFrom("issued_requirements")
        .select("binding")
        .where("binding", "=", binding)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it("loads relayer key files (NEAR secret keys or near-cli credentials)", () => {
    const dir = mkdtempSync(join(tmpdir(), "keys-"));
    const a = relayerKey();
    const b = relayerKey();
    writeFileSync(join(dir, "relayer_key_1"), `${a.secretKey}\n`);
    writeFileSync(
      join(dir, "relayer_key_2"),
      JSON.stringify({ account_id: "relayer.near", public_key: b.publicKey, private_key: b.secretKey }),
    );
    writeFileSync(join(dir, "other"), "ignored");
    expect(loadKeyFiles(join(dir, "relayer_key_*")).map((k) => k.publicKey)).toEqual([a.publicKey, b.publicKey]);
    expect(loadKeyFiles(undefined)).toEqual([]);
    expect(() => parseKeyFile("secp256k1:abc")).toThrow();
    writeFileSync(join(dir, "relayer_key_3"), "ed25519:1111");
    expect(() => loadKeyFiles(join(dir, "relayer_key_*"))).toThrow(/relayer_key_3/);
  });
});
