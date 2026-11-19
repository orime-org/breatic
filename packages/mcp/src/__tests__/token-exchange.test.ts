// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { TokenExchangeRateLimitedError, TokenExchangeUnavailableError, createTokenExchanger, discoverTokenEndpoint } from "@mcp/token-exchange.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

/** What the fake token endpoint saw. */
interface Seen {
  deliveries: number;
  authorization?: string;
  contentType?: string;
  form?: URLSearchParams;
}

/**
 * A token endpoint that answers every request the same way.
 * @param status - Its status.
 * @param body - Its JSON body.
 * @param headers - Extra headers.
 * @returns Its URL and what it saw.
 */
async function tokenEndpoint(status: number, body: unknown, headers: Record<string, string> = {}): Promise<{ url: string; seen: Seen }> {
  const seen: Seen = { deliveries: 0 };
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      seen.deliveries += 1;
      seen.authorization = req.headers.authorization;
      seen.contentType = req.headers["content-type"];
      seen.form = new URLSearchParams(raw);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/token`, seen };
}

const ANSWER = {
  access_token: "downstream",
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "Bearer",
  expires_in: 300,
  user_id: randomUUID(),
  connection_id: randomUUID(),
  credential: { type: "pat", tokenId: "tok-1" },
};

describe("createTokenExchanger", () => {
  it("trades the agent's token as the MCP client and returns who it stands for", async () => {
    const { url, seen } = await tokenEndpoint(200, ANSWER);
    const exchange = createTokenExchanger({ tokenEndpoint: url, clientSecret: "s3cret", timeoutMs: 5_000 });
    expect(await exchange("agent-token")).toEqual(ANSWER);
    expect(seen.authorization).toBe(`Basic ${Buffer.from("breatic-mcp:s3cret").toString("base64")}`);
    expect(seen.contentType).toContain("application/x-www-form-urlencoded");
    expect(Object.fromEntries(seen.form!)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "agent-token",
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
  });

  it("returns null for a token the server will not trade", async () => {
    const { url } = await tokenEndpoint(400, { error: "invalid_grant" });
    expect(await createTokenExchanger({ tokenEndpoint: url, clientSecret: "s", timeoutMs: 5_000 })("old")).toBeNull();
  });

  it("waits out the server's Retry-After and carries it on when the user is still over their rate", async () => {
    const { url, seen } = await tokenEndpoint(429, { error: "temporarily_unavailable" }, { "retry-after": "1" });
    const exchange = createTokenExchanger({ tokenEndpoint: url, clientSecret: "s", timeoutMs: 10_000 });
    await expect(exchange("t")).rejects.toMatchObject({ name: TokenExchangeRateLimitedError.name, retryAfterSeconds: 1 });
    expect(seen.deliveries).toBe(3);
  });

  it("gives up inside the call's budget while it is still waiting", async () => {
    const { url } = await tokenEndpoint(429, { error: "temporarily_unavailable" }, { "retry-after": "1" });
    const started = Date.now();
    const exchange = createTokenExchanger({ tokenEndpoint: url, clientSecret: "s", timeoutMs: 1_500 });
    await expect(exchange("t")).rejects.toBeInstanceOf(TokenExchangeUnavailableError);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("throws on any other failure, so the call is answered as a server error", async () => {
    const { url } = await tokenEndpoint(401, { error: "invalid_client" });
    await expect(createTokenExchanger({ tokenEndpoint: url, clientSecret: "wrong", timeoutMs: 5_000 })("t")).rejects.toThrow(/401/);
  });
});

describe("discoverTokenEndpoint", () => {
  it("reads the token endpoint from the issuer's authorization server metadata", async () => {
    const { url, seen } = await tokenEndpoint(200, { issuer: "http://127.0.0.1", token_endpoint: "http://127.0.0.1/oauth/token" });
    const issuer = new URL(url).origin;
    expect(await discoverTokenEndpoint(issuer, 5_000)).toBe(`${issuer}/oauth/token`);
    expect(seen.deliveries).toBe(1);
  });

  it("keeps the endpoint's path on the server address this service reaches, whatever host the public issuer names", async () => {
    const { url } = await tokenEndpoint(200, { issuer: "https://breatic.example", token_endpoint: "https://breatic.example/oauth/token" });
    const server = new URL(url).origin;
    expect(await discoverTokenEndpoint(server, 5_000)).toBe(`${server}/oauth/token`);
  });

  it("refuses metadata without a token endpoint", async () => {
    const { url } = await tokenEndpoint(200, { issuer: "http://127.0.0.1" });
    await expect(discoverTokenEndpoint(new URL(url).origin, 5_000)).rejects.toThrow();
  });
});
