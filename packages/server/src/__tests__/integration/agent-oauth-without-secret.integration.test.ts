// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A deployment that leaves `MCP_CLIENT_SECRET` empty turns external-agent
 * connections off (#1488 §5.2, `.env.docker`): the MCP service's confidential
 * client is not registered, so no secret, the empty one included, can trade a
 * token for a downstream token. Its own file because core is configured once
 * per file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { initCore, loadLocales } from "@breatic/core";

let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address() as AddressInfo;
      probe.close(() => resolve(free));
    });
  });
  base = `http://127.0.0.1:${port}`;
  initCore({ ...process.env, OAUTH_ISSUER: base, MCP_PUBLIC_URL: `${base}/mcp`, MCP_CLIENT_SECRET: "" });
  loadLocales();
  const { createApp } = await import("@server/app.js");
  const app = createApp();
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => resolve(s));
  });
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close?.();
});

describe("token exchange with no MCP client secret", () => {
  it.each([
    ["an empty secret", ""],
    ["any other secret", "guessed-secret"],
  ])("refuses the MCP client with %s as invalid_client", async (_label, secret) => {
    const res = await fetch(new URL("/oauth/token", base), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`breatic-mcp:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: "brt_anything",
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
  });
});
