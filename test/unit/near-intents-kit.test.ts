/**
 * The kit 0.3.0 helpers agentpay uses (`@nearpay-internal/intents`, via src/domain/near-intents/kit.ts) against the
 * spec 0.3.0 vectors: near-intents binding, operation token mint/verify (expiry first, unknown key, any change of the
 * covered input), and JCS limits.
 */
import { quotedRequirements } from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import {
  jcs,
  mintOperationToken,
  type NearIntentsBindingInput,
  nearIntentsBinding,
  type OperationTokenInput,
  verifyOperationToken,
} from "../../src/domain/near-intents/kit.js";
import { NEAR_INTENTS_VECTORS as V } from "../support/vectors.js";

const key = Buffer.from(V.operation_token.key_hex, "hex");
const keys = new Map([[V.operation_token.kid, new Uint8Array(key)]]);
const input = V.operation_token.input as unknown as OperationTokenInput;
const { expiry, ...unexpiring } = input;

describe("near-intents binding (spec vector)", () => {
  it("hashes the JCS of the binding input", () => {
    const b = V.binding.input as unknown as NearIntentsBindingInput;
    expect(jcs(b)).toBe(V.binding.jcs);
    expect(nearIntentsBinding(b)).toBe(V.binding.binding);
  });
  it("refuses another method and a malformed nonce", () => {
    const b = V.binding.input as unknown as NearIntentsBindingInput;
    expect(() => nearIntentsBinding({ ...b, method: "intents-transfer" as never })).toThrow(RangeError);
    expect(() => nearIntentsBinding({ ...b, nonce16: "ABC" })).toThrow(RangeError);
  });
});

describe("operation token (spec vector)", () => {
  it("mints the vector token from the vector key and input", () => {
    expect(jcs(input)).toBe(V.operation_token.jcs);
    expect(mintOperationToken(key, V.operation_token.kid, input)).toBe(V.operation_token.token);
    expect(V.operation_token.token.split(".")[2]).toBe(V.operation_token.mac);
  });
  it("verifies with the recomputed input before the expiry", () => {
    expect(verifyOperationToken(V.operation_token.token, keys, unexpiring, expiry - 1)).toEqual({
      ok: true,
      kid: "k1",
      expiry,
    });
  });
  it("is expired at its expiry, without needing the key", () => {
    expect(verifyOperationToken(V.operation_token.token, new Map(), unexpiring, expiry)).toEqual({
      ok: false,
      reason: "expired",
    });
  });
  it("refuses an unknown kid, a malformed token and any change of the covered input", () => {
    expect(verifyOperationToken(V.operation_token.token, new Map([["k2", key]]), unexpiring, 0).ok).toBe(false);
    expect(verifyOperationToken("k1.1.short", keys, unexpiring, 0)).toEqual({ ok: false, reason: "malformed" });
    const changes: Partial<Omit<OperationTokenInput, "expiry">>[] = [
      { binding: "np1:FkMXJmBuTZEMpEvn6a6VRVGugj435HBY98sUfKJhinuk" },
      { network: "eip155:1" },
      { deposit_address: "0x76b4c56085ED136a8744D52bE956396624a730E9" },
      { deposit_memo: "1" },
      { resource_url: "https://merchant.example/other" },
      { destination: { ...input.destination, amount: "1000001" } },
      { destination: { ...input.destination, recipient: "attacker.near" } },
    ];
    for (const c of changes)
      expect(verifyOperationToken(V.operation_token.token, keys, { ...unexpiring, ...c }, 0)).toEqual({
        ok: false,
        reason: "invalid",
      });
    // a token whose expiry part was extended no longer matches its MAC
    const [kid, , mac] = V.operation_token.token.split(".");
    expect(verifyOperationToken(`${kid}.${expiry + 1}.${mac}`, keys, unexpiring, 0)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
  it("refuses short keys, bad kids and other construction versions when minting", () => {
    expect(() => mintOperationToken(key.subarray(0, 31), "k1", input)).toThrow(RangeError);
    expect(() => mintOperationToken(key, "K1", input)).toThrow(RangeError);
    expect(() => mintOperationToken(key, "k1", { ...input, v: 2 as never })).toThrow(RangeError);
  });
});

describe("jcs", () => {
  it("sorts keys, skips undefined and refuses floats, arrays and booleans", () => {
    expect(jcs({ b: 1, a: null, c: undefined, d: { z: "x", y: "é" } })).toBe('{"a":null,"b":1,"d":{"y":"é","z":"x"}}');
    expect(() => jcs(1.5)).toThrow(RangeError);
    expect(() => jcs([1])).toThrow(TypeError);
    expect(() => jcs(true)).toThrow(TypeError);
  });
});

describe("flow shapes (spec vectors)", () => {
  it("the quoted 402 entry is quotedRequirements(unquoted, verify extra)", () => {
    const unquoted = (V.headers.payment_required_unquoted as { accepts: unknown[] }).accepts[0];
    const quoted = (V.headers.payment_required_quoted as { accepts: unknown[] }).accepts[0];
    const extra = (V.headers.verify_response_quote as { extra: unknown }).extra;
    expect(quotedRequirements(unquoted as never, extra as never)).toEqual(quoted);
  });
});
