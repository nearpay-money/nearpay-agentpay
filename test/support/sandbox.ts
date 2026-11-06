/**
 * The real nearpay-sandbox image (`nearpay/sandbox:local`) on the host network, its database on the
 * harness Postgres: the simulated Verifier with real signature checks, balances, nonces and the DIP-4 /
 * NEP-245 event feed (test mode never touches mainnet, INV-8).
 */
import { generateKeyPairSync } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { publicJwk } from "@nearpay-internal/auth";
import { mintServiceToken, provisionServiceDatabase, testSigningKey } from "@nearpay-internal/testing";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

export const SANDBOX_IMAGE = process.env.NP_SANDBOX_IMAGE ?? "nearpay/sandbox:local";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function waitHttp(url: string, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) return;
    } catch {}
    if (Date.now() > until) throw new Error(`${url} did not become ready`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface RealSandbox {
  readonly url: string;
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  stop(): Promise<void>;
}

export async function startSandbox(pgUrl: string): Promise<RealSandbox> {
  // JWKS for the container (it verifies agentpay's service tokens like it would identity's)
  const jwk = await publicJwk(testSigningKey());
  const jwks: Server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [{ ...jwk, alg: "EdDSA", use: "sig" }] }));
  });
  await new Promise<void>((r) => jwks.listen(0, "127.0.0.1", r));
  const jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/internal/jwks`;
  const { migratorUrl, appUrl } = await provisionServiceDatabase(pgUrl, "sandbox");
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const port = await freePort();
  const metricsPort = await freePort();
  const base = (dbUrl: string) =>
    new GenericContainer(SANDBOX_IMAGE)
      .withNetworkMode("host")
      .withCopyContentToContainer([
        { content: dbUrl, target: "/run/secrets/db_url", mode: 0o444 },
        { content: pem, target: "/run/secrets/key", mode: 0o444 },
      ])
      .withEnvironment({
        NP_ENV: "local",
        NP_LOG_LEVEL: "warn",
        NP_PORT: String(port),
        NP_METRICS_PORT: String(metricsPort),
        NP_HOST: "127.0.0.1",
        NP_DB_URL_FILE: "/run/secrets/db_url",
        NP_SANDBOX_SIGNING_KEY_FILE: "/run/secrets/key",
        NP_JWKS_URL: jwksUrl,
        NP_SANDBOX_TIME_SCALE: "0.02",
        NP_SANDBOX_TICK_MS: "25",
      });
  const containers: StartedTestContainer[] = [];
  containers.push(
    await base(migratorUrl).withCommand(["dist/main.js", "migrate"]).withWaitStrategy(Wait.forOneShotStartup()).start(),
  );
  containers.push(await base(appUrl).withCommand(["dist/main.js", "api"]).start());
  const url = `http://127.0.0.1:${port}`;
  await waitHttp(`${url}/readyz`);
  return {
    url,
    async call(method, path, body) {
      const r = await fetch(`${url}${path}`, {
        method,
        headers: {
          "x-nearpay-token": await mintServiceToken("agentpay"),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : undefined };
    },
    async stop() {
      for (const c of containers.reverse()) await c.stop().catch(() => {});
      await new Promise<void>((r) => jwks.close(() => r()));
    },
  };
}
