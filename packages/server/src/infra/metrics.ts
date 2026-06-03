// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Prometheus metrics for the API server.
 *
 * A tiny, dependency-light metrics surface scraped at `GET /metrics` on
 * the ops health port (3001), wired in `index.ts` via the health
 * server's `onMetrics` hook — NOT on the main Hono port, so scrape
 * traffic stays off the request path (mirrors the `/healthz` split).
 *
 * Three signals, per the "industrial-grade server standards" mandate's
 * "metrics (error rate / connection pool / latency)" line:
 *  - prom-client default process metrics (event-loop lag, heap, GC),
 *    which catch process-level drift.
 *  - `http_requests_total` — a counter labelled by method + status, so
 *    error rate is `rate(http_requests_total{status=~"5.."}[5m])`.
 *  - `db_up` — a 1/0 SELECT-1 liveness gauge refreshed on each scrape.
 *    postgres.js does not expose live pool stats, so this is the honest
 *    db signal: a drifted pool surfaces as `db_up 0` / failing queries.
 *
 * Pinned to prom-client v14, which has NO `@opentelemetry/api` dependency.
 * v15 added that dep (for exemplars), and its ESM build breaks vitest's
 * Node resolver (`baggage/utils` imported without an extension) — which
 * would cascade-fail every test that loads `createApp`. v14 keeps the
 * metrics path otel-free, matching the unit tests that deliberately mock
 * `ai` to avoid loading otel at all.
 */

import type { MiddlewareHandler } from "hono";
import { Registry, Counter, Gauge, collectDefaultMetrics } from "prom-client";
import { pingDb } from "@breatic/core";

/** Process-wide Prometheus registry; one per server process. */
const register = new Registry();
collectDefaultMetrics({ register });

/** Counts every HTTP request, labelled by method and response status code. */
const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled, labelled by method and response status.",
  labelNames: ["method", "status"],
  registers: [register],
});

/** 1 when the last-scrape Postgres SELECT-1 probe succeeded, 0 otherwise. */
const dbUp = new Gauge({
  name: "db_up",
  help: "1 if the Postgres SELECT-1 liveness probe succeeds, 0 otherwise.",
  registers: [register],
});

/**
 * Hono middleware that increments {@link httpRequestsTotal} once each
 * request resolves. Labels by method + status only (no path) so a
 * high-cardinality id like `/projects/<uuid>` never explodes the series.
 * @param c - The Hono request context; read for method and final status.
 * @param next - The downstream handler, awaited so the status is final.
 */
export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  httpRequestsTotal.inc({ method: c.req.method, status: String(c.res.status) });
};

/**
 * Render the Prometheus exposition text for one `/metrics` scrape,
 * refreshing the {@link dbUp} gauge with a live SELECT-1 probe first.
 * @returns The Prometheus text-format metrics payload.
 */
export async function renderMetrics(): Promise<string> {
  const ok = await pingDb();
  dbUp.set(ok ? 1 : 0);
  return register.metrics();
}
