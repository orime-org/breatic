// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import type { AgentTokenExchangeResponse } from "@breatic/shared";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createMcpApp, type AgentCall } from "@mcp/app.js";
import { TokenExchangeRateLimitedError, TokenExchangeUnavailableError } from "@mcp/token-exchange.js";

const RESOURCE = "http://localhost:3103/mcp";
const METADATA_URL = "http://localhost:3103/.well-known/oauth-protected-resource/mcp";
const IDENTITY: AgentTokenExchangeResponse = {
  access_token: "downstream",
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "Bearer",
  expires_in: 300,
  user_id: randomUUID(),
  connection_id: randomUUID(),
  credential: { type: "oauth", grantId: "g-1" },
};

/**
 * The app over a fake exchange.
 * @param exchange - What the exchange answers.
 * @returns The app and the calls its tools saw.
 */
function appWith(exchange: (token: string) => Promise<AgentTokenExchangeResponse | null>): { app: ReturnType<typeof createMcpApp>; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  const app = createMcpApp({
    resourceUrl: new URL(RESOURCE),
    issuer: "http://localhost:3100",
    exchange,
    buildServer: (call) => {
      calls.push(call);
      return new McpServer({ name: "breatic", version: "test" });
    },
  });
  return { app, calls };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

/**
 * POST one JSON-RPC message to the MCP address.
 * @param app - The app.
 * @param headers - Extra headers.
 * @returns The response.
 */
async function post(app: ReturnType<typeof createMcpApp>, headers: Record<string, string>): Promise<Response> {
  return app.request(RESOURCE, {
    method: "POST",
    headers: { host: "localhost:3103", "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(INITIALIZE),
  });
}

describe("protected resource metadata", () => {
  it.each(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"])("names the issuer at %s", async (path) => {
    const { app } = appWith(async () => null);
    const res = await app.request(`http://localhost:3103${path}`, { headers: { host: "localhost:3103" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: ["http://localhost:3100"],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  });
});

describe("the MCP address", () => {
  it("answers 401 with where to find the authorization server when no token comes", async () => {
    const { app } = appWith(async () => IDENTITY);
    const res = await post(app, {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${METADATA_URL}"`);
  });

  it("answers 401 invalid_token when the server will not trade the token", async () => {
    const { app } = appWith(async () => null);
    const res = await post(app, { authorization: "Bearer stale" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("passes the server's rate limit on as 429 with its wait", async () => {
    const { app } = appWith(async () => {
      throw new TokenExchangeRateLimitedError(17);
    });
    const res = await post(app, { authorization: "Bearer t" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
  });

  it("answers 503 when the exchange did not finish inside the call's budget", async () => {
    const { app } = appWith(async () => {
      throw new TokenExchangeUnavailableError(new Error("timed out"));
    });
    const res = await post(app, { authorization: "Bearer t" });
    expect(res.status).toBe(503);
  });

  it("serves the call as the token's user once the exchange succeeds", async () => {
    const seen: string[] = [];
    const { app, calls } = appWith(async (token) => {
      seen.push(token);
      return IDENTITY;
    });
    const res = await post(app, { authorization: "Bearer agent-token" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"name":"breatic"');
    expect(seen).toEqual(["agent-token"]);
    expect(calls).toEqual([
      {
        downstreamToken: "downstream",
        userId: IDENTITY.user_id,
        connectionId: IDENTITY.connection_id,
        credential: IDENTITY.credential,
        startedAt: expect.any(Number),
      },
    ]);
  });

  it("refuses a request for another host", async () => {
    const { app } = appWith(async () => IDENTITY);
    const res = await post(app, { host: "evil.example", authorization: "Bearer t" });
    expect(res.status).toBe(403);
  });
});
