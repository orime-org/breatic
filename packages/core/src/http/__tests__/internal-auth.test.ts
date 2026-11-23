// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * One internal listener's authentication built by `createInternalAuth`: it
 * checks against the secrets its service hands it, remembers nonces under the
 * service's prefix, and reports every refusal instead of logging.
 */

import { Hono } from "hono";
import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInternalAuth } from "@core/http/internal-auth.js";
import { signRequest } from "@core/http/internal-signature.js";

const SECRET = "listener-secret";
const set = vi.fn();
const report = vi.fn();
const internalAuth = createInternalAuth({
  secrets: () => ({ current: SECRET, previous: "" }),
  redis: () => ({ set }) as unknown as Redis,
  keyPrefix: () => "test",
  report,
});

const app = new Hono();
app.use("*", internalAuth());
app.get("/internal/v1/x", (c) => c.json({ admin: c.get("internalAdmin") }));

/**
 * A GET to the test route signed with `secret`.
 * @param secret - The secret to sign with.
 * @param nonce - The request's nonce.
 * @returns The response.
 */
function signedGet(secret: string, nonce = "nonce-0123456789ab"): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const parts = {
    method: "GET",
    pathWithQuery: "/internal/v1/x",
    timestamp,
    nonce,
    adminId: "admin-1",
    idempotencyKey: null,
    body: "",
  };
  return Promise.resolve(
    app.request("/internal/v1/x", {
      headers: {
        "x-internal-admin": "admin-1",
        "x-internal-timestamp": timestamp,
        "x-internal-nonce": nonce,
        "x-internal-signature": signRequest(secret, parts),
      },
    }),
  );
}

beforeEach(() => {
  set.mockReset();
  report.mockReset();
});

describe("createInternalAuth", () => {
  it("lets a request signed with the listener's secret through and remembers its nonce under the prefix", async () => {
    set.mockResolvedValue("OK");
    const res = await signedGet(SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ admin: "admin-1" });
    expect(set).toHaveBeenCalledWith("test:server:internal-nonce:nonce-0123456789ab", "1", "EX", 602, "NX");
    expect(report).not.toHaveBeenCalled();
  });

  it("refuses a request signed with another secret and reports the failed step", async () => {
    const res = await signedGet("another-secret");
    expect(res.status).toBe(401);
    expect(report).toHaveBeenCalledWith({ kind: "rejected", step: "signature", path: "/internal/v1/x" });
    expect(set).not.toHaveBeenCalled();
  });

  it("refuses a replayed nonce and reports it", async () => {
    set.mockResolvedValue(null);
    const res = await signedGet(SECRET);
    expect(res.status).toBe(401);
    expect(report).toHaveBeenCalledWith({ kind: "rejected", step: "nonce", path: "/internal/v1/x" });
  });

  it("answers 503 and reports when the nonce store is unreachable", async () => {
    const err = new Error("redis down");
    set.mockRejectedValue(err);
    const res = await signedGet(SECRET);
    expect(res.status).toBe(503);
    expect(report).toHaveBeenCalledWith({ kind: "nonce_unavailable", err });
  });
});
