// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The signed client one service uses to call the other's internal listener:
 * each delivery is signed so the receiver's `verifyInternalRequest` accepts it,
 * a non-2xx answer becomes `SignedCallError` carrying the status and code, and
 * `isUnavailable` tells "the other side cannot handle this now" from a
 * definite answer.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyInternalRequest } from "@core/http/internal-signature.js";
import { isUnavailable, signedCall, SignedCallError } from "@core/http/signed-call.js";

const SECRET = "shared-secret";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

const seen: Seen[] = [];
let answer: { status: number; body: string } = { status: 200, body: "{}" };
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
  answer = { status: 200, body: "{}" };
});

/**
 * Run the receiver's signature check over a request the test server saw.
 * @param request - The request as received.
 * @returns The verdict.
 */
function verify(request: Seen): ReturnType<typeof verifyInternalRequest> {
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  return verifyInternalRequest(
    {
      method: request.method,
      pathWithQuery: request.url,
      headers: {
        "x-internal-admin": header("x-internal-admin"),
        "x-internal-timestamp": header("x-internal-timestamp"),
        "x-internal-nonce": header("x-internal-nonce"),
        "x-internal-signature": header("x-internal-signature"),
        "idempotency-key": header("idempotency-key"),
      },
      body: request.body,
    },
    { current: SECRET, previous: "" },
    Math.floor(Date.now() / 1000),
  );
}

describe("signedCall", () => {
  it("sends a request the receiver's signature check accepts, signed by the caller, and returns the parsed answer", async () => {
    answer = { status: 200, body: JSON.stringify({ lotId: "lot-1" }) };
    const result = await signedCall(
      { baseUrl, secret: SECRET, signer: "commerce" },
      {
        method: "POST",
        path: "/internal/v1/commerce/payment-grants/p-1?locale=en",
        body: { userId: "u-1" },
        idempotencyKey: "grant:p-1",
        timeoutMs: 2000,
      },
    );
    expect(result).toEqual({ status: 200, body: { lotId: "lot-1" } });
    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/internal/v1/commerce/payment-grants/p-1?locale=en");
    expect(JSON.parse(request.body)).toEqual({ userId: "u-1" });
    expect(request.headers["idempotency-key"]).toBe("grant:p-1");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(verify(request)).toMatchObject({ ok: true, adminId: "commerce" });
  });

  it("signs a GET with no body and no idempotency key", async () => {
    await signedCall(
      { baseUrl, secret: SECRET, signer: "product" },
      { method: "GET", path: "/v1/users/u-1/payment/tiers", timeoutMs: 2000 },
    );
    const request = seen[0]!;
    expect(request.body).toBe("");
    expect(request.headers["idempotency-key"]).toBeUndefined();
    expect(verify(request)).toMatchObject({ ok: true, adminId: "product" });
  });

  it("signs the path as it goes on the wire, where the URL parser escapes what encodeURIComponent leaves", async () => {
    await signedCall(
      { baseUrl, secret: SECRET, signer: "product" },
      { method: "GET", path: `/v1/users/u-1/payment/history/unlanded?limit=2&before=${encodeURIComponent("it's")}`, timeoutMs: 2000 },
    );
    const request = seen[0]!;
    expect(request.url).toBe("/v1/users/u-1/payment/history/unlanded?limit=2&before=it%27s");
    expect(verify(request)).toMatchObject({ ok: true, adminId: "product" });
  });

  it("uses a fresh nonce for every call", async () => {
    const target = { baseUrl, secret: SECRET, signer: "commerce" };
    await signedCall(target, { method: "GET", path: "/a", timeoutMs: 2000 });
    await signedCall(target, { method: "GET", path: "/a", timeoutMs: 2000 });
    expect(seen[0]!.headers["x-internal-nonce"]).not.toBe(seen[1]!.headers["x-internal-nonce"]);
  });

  it("delivers a failing call once, so the receiver never sees the same nonce twice", async () => {
    answer = { status: 503, body: JSON.stringify({ code: "unavailable" }) };
    await expect(
      signedCall({ baseUrl, secret: SECRET, signer: "commerce" }, { method: "GET", path: "/a", timeoutMs: 2000 }),
    ).rejects.toBeInstanceOf(SignedCallError);
    expect(seen).toHaveLength(1);
  });

  it("throws SignedCallError with the status and the internal error code of a non-2xx answer", async () => {
    answer = { status: 409, body: JSON.stringify({ code: "receipt_conflict", detail: "amount differs" }) };
    const err = await signedCall(
      { baseUrl, secret: SECRET, signer: "commerce" },
      { method: "POST", path: "/a", body: {}, idempotencyKey: "k", timeoutMs: 2000 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignedCallError);
    expect(err).toMatchObject({ status: 409, code: "receipt_conflict", body: { code: "receipt_conflict", detail: "amount differs" } });
  });

  it("reads the code of a public error body too", async () => {
    answer = { status: 422, body: JSON.stringify({ error: { code: "VALIDATION", message: "bad" } }) };
    const err = await signedCall(
      { baseUrl, secret: SECRET, signer: "product" },
      { method: "GET", path: "/a", timeoutMs: 2000 },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: "VALIDATION" });
  });

  it("throws SignedCallError with no status when nothing answers", async () => {
    const err = await signedCall(
      { baseUrl: "http://127.0.0.1:1", secret: SECRET, signer: "commerce" },
      { method: "GET", path: "/a", timeoutMs: 2000 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignedCallError);
    expect(err).toMatchObject({ status: null, code: null });
  });
});

describe("isUnavailable", () => {
  it.each([401, 403, 408, 429, 500, 502, 503, 504])("treats %i as the other side being unavailable", (status) => {
    expect(isUnavailable(new SignedCallError(status, null, null))).toBe(true);
  });

  it("treats no answer as unavailable", () => {
    expect(isUnavailable(new SignedCallError(null, null, null))).toBe(true);
  });

  it.each([400, 404, 409, 422])("treats %i as a definite answer", (status) => {
    expect(isUnavailable(new SignedCallError(status, "x", null))).toBe(false);
  });

  it("treats an error that is not a SignedCallError as not this call's verdict", () => {
    expect(isUnavailable(new Error("boom"))).toBe(false);
  });
});
