import { describe, expect, it } from "vitest";
import type { Agentpay } from "../../src/app/context.js";
import { runOps } from "../../src/ops/cli.js";

describe("ops CLI: dead-letters / outbox (kit 0.6.0 runKitOps)", () => {
  it("routes to the kit and prints its usage on a bad sub-command", async () => {
    const errs: string[] = [];
    const ap = { db: {}, waiters: {}, log: {} } as unknown as Agentpay;
    const deps = { err: (l: string) => errs.push(l), out: () => {} };
    expect(await runOps(["dead-letters", "show"], ap, deps)).toBe(2);
    expect(await runOps(["outbox", "skip", "x"], ap, deps)).toBe(2);
    expect(errs.join("\n")).toContain("dead-letters replay <id>");
  });
});
