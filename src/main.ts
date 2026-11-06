/**
 * Process entry (foundations §15, lld/agentpay.md §2): `node dist/main.js api|batcher|migrate|healthcheck`.
 * - `api`      public x402 + `/v1/agent_payments` + checkout agent pay, internal `/internal/relay` (2 replicas)
 * - `batcher`  batching relayer (leader), kill-switch consumer, jobs, outbox relay
 * - `migrate`  applies kit + agentpay migrations with the migrator role (one-shot)
 */
import { createDb, migrate } from "@nearpay-internal/db";
import { loadConfig, runMain } from "@nearpay-internal/service";
import { migrateShape, readApiConfig, readBatcherConfig } from "./config.js";
import { MIGRATIONS_DIR } from "./infra/db/migrations.js";

await runMain({
  api: async () => {
    const { createApi } = await import("./app/services.js");
    return createApi(readApiConfig()).service;
  },
  batcher: async () => {
    const { createBatcher } = await import("./app/services.js");
    return (await createBatcher(readBatcherConfig())).service;
  },
  migrate: async () => {
    const config = loadConfig(migrateShape);
    const database = createDb({ url: config.dbUrl, applicationName: "agentpay-migrate" });
    try {
      const applied = await migrate(database.db, MIGRATIONS_DIR, (m) => process.stdout.write(`${m}\n`));
      process.stdout.write(`migrations up to date (${applied.length} applied)\n`);
    } finally {
      await database.close();
    }
    return undefined;
  },
});
