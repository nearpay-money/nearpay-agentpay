/**
 * Jobs run by `agentpay-batcher` (leases, backoff, dead letters):
 *
 * | kind                 | when   | what                                                               |
 * |----------------------|--------|--------------------------------------------------------------------|
 * | requirements.purge   | hourly | unconsumed x402 requirements expired > 24 h; checkout requirements > 7 days; near-intents operations 30 days after their token expired |
 * | relayer.allowance    | 5 min  | allowance of each relayer key (gauge + alert below 20%, RB-09)     |
 * | kit.purge            | hourly | published outbox, old inbox, expired idempotency keys              |
 */
import { type JobHandler, purgeKitTables, type RecurringJob } from "@nearpay-internal/db";
import type { Agentpay } from "../app/context.js";
import { OPERATION_PURGE_AFTER_MS } from "../app/near-intents.js";
import type { Batcher } from "../relayer/batcher/batcher.js";

const HOUR = 3_600_000;
export const REQUIREMENTS_PURGE_JOB = "requirements.purge";
export const ALLOWANCE_JOB = "relayer.allowance";

export const RECURRING: readonly RecurringJob[] = [
  { kind: REQUIREMENTS_PURGE_JOB, everyMs: HOUR },
  { kind: ALLOWANCE_JOB, everyMs: 5 * 60_000 },
  { kind: "kit.purge", everyMs: HOUR },
];

export function jobHandlers(ap: Agentpay, b: Batcher): Record<string, JobHandler> {
  return {
    [REQUIREMENTS_PURGE_JOB]: async () => {
      const x402 = await ap.db
        .deleteFrom("issued_requirements")
        .where("consumed_at", "is", null)
        .where("expires_at", "<", new Date(ap.now() - 24 * HOUR))
        .executeTakeFirst();
      const checkout = await ap.db
        .deleteFrom("checkout_requirements")
        .where("updated_at", "<", new Date(ap.now() - 7 * 24 * HOUR))
        .executeTakeFirst();
      // §4.1: a token is rejected before any lookup once expired, so the row is only kept for support
      const operations = await ap.db
        .deleteFrom("x402_operations")
        .where("token_expiry", "<", new Date(ap.now() - OPERATION_PURGE_AFTER_MS))
        .executeTakeFirst();
      ap.log.info(
        {
          x402: Number(x402.numDeletedRows),
          checkout: Number(checkout.numDeletedRows),
          operations: Number(operations.numDeletedRows),
        },
        "expired requirements purged",
      );
    },
    [ALLOWANCE_JOB]: async () => {
      await b.checkAllowances();
    },
    "kit.purge": async () => {
      ap.log.info(await purgeKitTables(ap.db), "kit tables purged");
    },
  };
}
