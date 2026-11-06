/** Shared fixtures from `@nearpay/spec/test-vectors` (consumed by producer and consumer tests). */
import { createRequire } from "node:module";
import type { MultiPayload } from "@nearpay/spec";

const require = createRequire(import.meta.url);

export interface IntentsVectors {
  salt_hex: string;
  nonce_base64: string;
  binding: string;
  nep413: { seed_hex: string; signer_id: string; hash_hex: string; multipayload: MultiPayload };
  erc191: { private_key_hex: string; address: string; hash_hex: string; multipayload: MultiPayload };
  raw_ed25519: { seed_hex: string; signer_id: string; multipayload: MultiPayload };
}

export const INTENTS_VECTORS = require("@nearpay/spec/test-vectors/intents-payloads.json") as IntentsVectors;

/** The requirement every vector pays: 2 USDC to merchant.near + 0.006 USDC fee, memo = binding. */
export const VECTOR_REQUIREMENT = {
  payTo: "merchant.near",
  asset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  amount: "2000000",
  feeTo: "treasury.nearpay.near",
  feeAmount: "6000",
  binding: INTENTS_VECTORS.binding,
  deadlineMaxMs: Date.parse("2026-11-05T10:02:00.000Z"),
  contract: "intents.near",
} as const;

/** A moment before the vectors' deadline (2026-11-05T10:02:00Z). */
export const VECTOR_NOW = Date.parse("2026-11-05T10:00:00.000Z");
