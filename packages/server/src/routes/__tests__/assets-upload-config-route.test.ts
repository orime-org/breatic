// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `GET /assets/upload-config` at the route layer: the upload knobs from the
 * storage config, and the public prefix every stored object's URL starts with
 * (a document body keeps a pasted media block only when its address carries
 * that prefix). Every upload in the browser reads this first, so a failure here
 * stops all of them.
 */

import { describe, it, expect, vi } from "vitest";

const PREFIX = "https://assets.example.test/";

vi.mock("@server/middleware/auth.js", () => ({
  requireAuth: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "u-1" });
    return next();
  },
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Lazy singletons resolving against the validated config, which no unit
    // test stands up.
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStorageConfig: () => ({
      upload: {
        max_upload_bytes: 2048,
        client_max_attempts: 4,
        client_retry_base_delay_ms: 250,
        client_request_timeout_ms: 30000,
        client_put_min_bytes_per_sec: 1024,
      },
    }),
    getStorageAdapter: async () => ({ publicUrl: (key: string) => `${PREFIX}${key}` }),
  };
});

const { assetsRoute } = await import("@server/routes/assets.js");
const { errorHandler } = await import("@server/middleware/error-handler.js");
const { Hono } = await import("hono");

const app = new Hono();
app.onError(errorHandler);
app.route("/", assetsRoute);

describe("GET /upload-config", () => {
  it("answers the upload knobs and the stored-object URL prefix", async () => {
    const res = await app.request("/upload-config");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        maxUploadBytes: 2048,
        clientMaxAttempts: 4,
        clientRetryBaseDelayMs: 250,
        clientRequestTimeoutMs: 30000,
        clientPutMinBytesPerSec: 1024,
        assetUrlPrefix: PREFIX,
      },
    });
  });
});
