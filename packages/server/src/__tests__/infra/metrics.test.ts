// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for the server Prometheus metrics surface.
 *
 * Pins the `#894` contract: a `/metrics` scrape renders `http_requests_total`
 * (request counter) + `db_up` (live SELECT-1 gauge) + prom-client default
 * process metrics. Also doubles as the otel-safety check — importing this
 * module loads `prom-client → @opentelemetry/api`, so a green run proves
 * that pull does not break vitest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@breatic/core", () => ({
  pingDb: vi.fn().mockResolvedValue(true),
}));

import { Hono } from "hono";
import { metricsMiddleware, renderMetrics } from "@server/infra/metrics.js";
import { pingDb } from "@breatic/core";

const pingDbMock = pingDb as unknown as ReturnType<typeof vi.fn>;

describe("server metrics", () => {
  beforeEach(() => {
    pingDbMock.mockReset().mockResolvedValue(true);
  });

  it("renders the registered metric families as Prometheus text", async () => {
    const text = await renderMetrics();
    expect(text).toContain("http_requests_total");
    expect(text).toContain("db_up");
    // prom-client default process metrics are registered too.
    expect(text).toContain("process_cpu_seconds_total");
  });

  it("db_up reflects the live pingDb probe (0 when down, 1 when up)", async () => {
    pingDbMock.mockResolvedValueOnce(false);
    expect(await renderMetrics()).toMatch(/^db_up 0$/m);

    pingDbMock.mockResolvedValueOnce(true);
    expect(await renderMetrics()).toMatch(/^db_up 1$/m);
  });

  it("http_requests_total increments per request, labelled by method + status", async () => {
    const app = new Hono();
    app.use("*", metricsMiddleware);
    app.get("/ok", (c) => c.text("ok"));
    app.get("/boom", (c) => c.json({ e: 1 }, 500));

    await app.request("/ok");
    await app.request("/boom");

    const text = await renderMetrics();
    expect(text).toMatch(/http_requests_total\{method="GET",status="200"\}\s+\d+/);
    expect(text).toMatch(/http_requests_total\{method="GET",status="500"\}\s+\d+/);
  });
});
