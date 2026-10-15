// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a page served from another origin may read off an answer
 * (inner#1367): the wait a 429 names, which the upload status list backs off by.
 */

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: { ALLOWED_ORIGINS: "https://app.example.com" },
}));

const { corsMiddleware } = await import("@server/middleware/cors.js");

describe("corsMiddleware", () => {
  it("lets a page on another origin read Retry-After", async () => {
    const app = new Hono();
    app.use("*", corsMiddleware);
    app.get("/limited", (c) => c.text("slow down", 429, { "Retry-After": "60" }));

    const res = await app.request("/limited", { headers: { Origin: "https://app.example.com" } });

    expect(res.status).toBe(429);
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
  });

  it("lets a page on another origin send Idempotency-Key", async () => {
    const app = new Hono();
    app.use("*", corsMiddleware);
    app.post("/run", (c) => c.text("ok"));

    const res = await app.request("/run", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, idempotency-key",
      },
    });

    expect(res.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain(
      "idempotency-key",
    );
  });

  it("lets a page on another origin read whether a run-once answer is final", async () => {
    const app = new Hono();
    app.use("*", corsMiddleware);
    app.post("/run", (c) => c.text("ok", 200, { "Idempotency-Status": "done" }));

    const res = await app.request("/run", {
      method: "POST",
      headers: { Origin: "https://app.example.com" },
    });

    const exposed = res.headers.get("Access-Control-Expose-Headers") ?? "";
    expect(exposed).toContain("Idempotency-Status");
    expect(exposed).toContain("Idempotent-Replayed");
  });
});
