/**
 * NearPay fee of an x402 requirement (lld/agentpay.md §3, §12): the identity fee schedule's
 * `intents_transfer` rule, `max(ceil(amount × bps / 10 000), minimum fee)`, where the minimum is
 * `min_fee_usd_micros` converted to base units at the asset's USD price, rounded up (fees round up,
 * foundations §6). The payer pays it on top of `amount`, as a second transfer to the treasury. Pure.
 */
import { bpsOf, ceil, div, maxOf, mul, parseDecimal, rational } from "@nearpay-internal/money";

/** A transfer intent moves at least one base unit; the fee transfer is never empty. */
export const MIN_FEE_UNITS = 1n;

/** USD micros → base units, rounded up; null when no usable price is known. */
export function unitsForUsdMicros(
  micros: bigint,
  asset: { decimals: number; price_usd: string | null; is_usd_stable: boolean },
): bigint | null {
  if (micros === 0n) return 0n;
  let price: ReturnType<typeof parseDecimal>;
  if (asset.price_usd !== null) {
    try {
      price = parseDecimal(asset.price_usd);
    } catch {
      return null;
    }
  } else if (asset.is_usd_stable) price = rational(1n);
  else return null;
  if (price.num <= 0n) return null;
  // units = micros / 1e6 / price × 10^decimals
  return ceil(div(mul(rational(micros, 1_000_000n), rational(10n ** BigInt(asset.decimals))), price));
}

export function x402Fee(amount: bigint, bps: number, minFeeUnits: bigint): bigint {
  return maxOf(bpsOf(amount, bps), minFeeUnits, MIN_FEE_UNITS);
}
