// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * One internal listener's authentication built by `createInternalAuth`: it
 * checks each signer against the secrets its service names for that signer,
 * keeps each signer to the paths the service allows it, remembers nonces under
 * the service's prefix, and reports every refusal instead of logging.
 */

import { Hono } from "hono";
import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInternalAuth } from "@core/http/internal-auth.js";
import { signRequest } from "@core/http/internal-signature.js";

const SECRET = "listener-secret";
const PARTNER_SECRET = "partner-secret";
const set = vi.fn();
const report = vi.fn();
const internalAuth = createInternalAuth({
  secretsFor: (signer) => {
    if (signer === "refused") return null;
    return { current: signer === "partner" ? PARTNER_SECRET : SECRET, previous: "" };
  },
  mayAccess: (signer, path) => (signer === "partner") === path.startsWith("/internal/v1/partner/"),
  redis: () => ({ set }) as unknown as Redis,
  keyPrefix: () => "test",
  report,
});

const app = new Hono();
app.use("*", internalAuth());
app.get("/internal/v1/x", (c) => c.json({ admin: c.get("internalAdmin") }));
app.get("/internal/v1/partner/x", (c) => c.json({ admin: c.get("internalAdmin") }));

/**
 * A GET signed with `secret`.
 * @param secret - The secret to sign with.
 * @param nonce - The request's nonce.
 * @param signer - Who the request says signed it.
 * @param path - The path requested.
 * @returns The response.
 */
function signedGet(
  secret: string,
  nonce = "nonce-0123456789ab",
  signer = "admin-1",
  path = "/internal/v1/x",
): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const parts = {
    method: "GET",
    pathWithQuery: path,
    timestamp,
    nonce,
    adminId: signer,
    idempotencyKey: null,
    body: "",
  };
  return Promise.resolve(
    app.request(path, {
      headers: {
        "x-internal-admin": signer,
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

  it("checks each signer against the secret its service names for that signer", async () => {
    set.mockResolvedValue("OK");
    const ok = await signedGet(PARTNER_SECRET, "nonce-partner-000001", "partner", "/internal/v1/partner/x");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ admin: "partner" });
    const wrongKey = await signedGet(SECRET, "nonce-partner-000002", "partner", "/internal/v1/partner/x");
    expect(wrongKey.status).toBe(401);
    expect(report).toHaveBeenCalledWith({ kind: "rejected", step: "signature", path: "/internal/v1/partner/x" });
  });

  it("refuses a signer its service accepts no secret for, before looking at the signature", async () => {
    const res = await signedGet(SECRET, "nonce-refused-000001", "refused");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "unauthorized" });
    expect(report).toHaveBeenCalledWith({ kind: "rejected", step: "signer", path: "/internal/v1/x" });
    expect(set).not.toHaveBeenCalled();
  });

  it("answers 403 to a correctly signed request for a path its signer may not reach, without using its nonce", async () => {
    const intoPartner = await signedGet(SECRET, "nonce-forbid-0000001", "admin-1", "/internal/v1/partner/x");
    expect(intoPartner.status).toBe(403);
    expect(await intoPartner.json()).toEqual({ code: "forbidden" });
    expect(report).toHaveBeenCalledWith({ kind: "forbidden", signer: "admin-1", path: "/internal/v1/partner/x" });
    const outOfPartner = await signedGet(PARTNER_SECRET, "nonce-forbid-0000002", "partner", "/internal/v1/x");
    expect(outOfPartner.status).toBe(403);
    expect(set).not.toHaveBeenCalled();
  });

  it("answers 503 and reports when the nonce store is unreachable", async () => {
    const err = new Error("redis down");
    set.mockRejectedValue(err);
    const res = await signedGet(SECRET);
    expect(res.status).toBe(503);
    expect(report).toHaveBeenCalledWith({ kind: "nonce_unavailable", err });
  });
});
