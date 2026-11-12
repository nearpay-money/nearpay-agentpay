/**
 * Stage 1 ops CLI (platform §3): `docker compose exec agentpay-api /nodejs/bin/node dist/ops.js
 * <command>`. Support tools; every command prints one JSON document; errors print `{"error": …}` and
 * exit 1 (2: usage). Adding a relayer key is a human-signed transaction (§9); the CLI only changes
 * how agentpay uses keys that exist.
 */
import { parseArgs } from "node:util";
import { DEAD_LETTER_USAGE, DeadLetterError, KitOpsUsageError, runKitOps } from "@nearpay-internal/db";
import { isId, toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { Subject } from "@nearpay-internal/spec";
import type { Agentpay } from "../app/context.js";
import { agentPaymentView } from "../app/views.js";
import { agentpayHandlers } from "../consumers/handlers.js";

export const USAGE = `usage: ops.js <command> [arguments]

  payment <ap_…>                         agent payment with its transitions and batch
  queue                                  agent payments by mode and status; open batches
  keys                                   relayer keys (status, in flight, last nonce, allowance)
  key-status <ed25519:…> <active|draining|retired>
                                         stop (draining/retired) or resume (active) using a relayer key
  kill-switch                            kill switch state as last announced by sentinel

dead letters and the outbox (kit 0.6.0):
${DEAD_LETTER_USAGE}`;

class UsageError extends Error {}

export interface OpsDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Recorded as `resolved_by` on dead letters and skipped outbox rows (default `cli:$USER`). */
  actor?: string;
}

const KIT_COMMANDS = new Set(["dead-letters", "outbox"]);

/** `dead-letters …` / `outbox …` (kit `runKitOps`): consumer dead letters replay through the worker's handlers (inbox-deduped). */
function kitOps(ap: Agentpay, argv: readonly string[], actor: string): Promise<unknown> {
  const handlers = agentpayHandlers(ap.db, { waiters: ap.waiters, log: ap.log });
  return runKitOps(ap.db, argv[0] as string, argv.slice(1), {
    actor,
    handlers: {
      consumer: async (e) => {
        const h = handlers[e.subject as Subject];
        if (!h) throw new DeadLetterError("no_handler", `agentpay does not consume ${e.subject}`);
        await h(e);
      },
    },
  });
}

export async function runOps(argv: readonly string[], ap: Agentpay, deps: OpsDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => process.stderr.write(`${l}\n`));
  try {
    if (KIT_COMMANDS.has(argv[0] ?? "")) {
      const result = await kitOps(ap, argv, deps.actor ?? `cli:${process.env.USER ?? "operator"}`);
      out(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      return 0;
    }
    const { positionals } = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: {} });
    const [cmd, ...args] = positionals;
    const result = await run(ap, cmd, args);
    out(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (e instanceof UsageError || e instanceof KitOpsUsageError || code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
      return 2;
    }
    err(
      JSON.stringify({
        error: e instanceof ApiError || e instanceof DeadLetterError ? { code: e.code, message: e.message } : String(e),
      }),
    );
    return 1;
  }
}

async function run(ap: Agentpay, cmd: string | undefined, args: readonly string[]): Promise<unknown> {
  switch (cmd) {
    case "payment": {
      const id = args[0];
      if (!id || !isId("ap", id)) throw new UsageError("expected an ap_… id");
      const row = await ap.db
        .selectFrom("agent_payments")
        .selectAll()
        .where("id", "=", toUuid(id, "ap"))
        .executeTakeFirst();
      if (!row) throw ApiError.missing("agent_payment", id);
      const [transitions, batch] = await Promise.all([
        ap.db
          .selectFrom("agent_payment_transitions")
          .selectAll()
          .where("agent_payment_id", "=", row.id)
          .orderBy("created_at", "asc")
          .execute(),
        row.batch_id
          ? ap.db.selectFrom("relay_batches").selectAll().where("id", "=", row.batch_id).executeTakeFirst()
          : Promise.resolve(null),
      ]);
      return {
        agent_payment: agentPaymentView(row),
        execution_id: row.execution_id,
        batch: batch ?? null,
        transitions,
      };
    }
    case "queue": {
      const [byStatus, batches] = await Promise.all([
        ap.db
          .selectFrom("agent_payments")
          .select(["livemode", "status", ap.db.fn.countAll<string>().as("n")])
          .groupBy(["livemode", "status"])
          .orderBy("livemode")
          .orderBy("status")
          .execute(),
        ap.db
          .selectFrom("relay_batches")
          .selectAll()
          .where("status", "in", ["building", "submitted"])
          .orderBy("created_at")
          .execute(),
      ]);
      return { payments: byStatus.map((r) => ({ ...r, n: Number(r.n) })), open_batches: batches };
    }
    case "keys":
      return { keys: await ap.db.selectFrom("relayer_keys").selectAll().orderBy("created_at").execute() };
    case "key-status": {
      const [key, status] = args;
      if (!key?.startsWith("ed25519:") || !["active", "draining", "retired"].includes(status ?? ""))
        throw new UsageError("expected <ed25519:…> <active|draining|retired>");
      const r = await ap.db
        .updateTable("relayer_keys")
        .set({ status: status as "active" })
        .where("public_key", "=", key)
        .returningAll()
        .executeTakeFirst();
      if (!r) throw ApiError.missing("relayer_key", key);
      ap.log.info({ key, status }, "relayer key status changed (ops)");
      return { key: r };
    }
    case "kill-switch":
      return {
        kill_switch: (await ap.db.selectFrom("kill_switch").selectAll().where("id", "=", 1).executeTakeFirst()) ?? {
          engaged: false,
          reason: "never engaged",
        },
      };
    default:
      throw new UsageError(cmd ? `unknown command ${cmd}` : "missing command");
  }
}
