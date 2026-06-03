/**
 * Health check HTTP server for long-lived services (collab, worker).
 *
 * Every long-lived service in the codebase must expose a `/healthz`
 * endpoint per the CLAUDE.md "industrial-grade server standards" mandate - a
 * docker / k8s / LB health probe with N-fail kill semantics is the
 * only mechanism that actually self-heals a process whose
 * downstream dependencies (PG pool, Redis connection) have drifted
 * silently. The 2026-05-27 long-running dev:collab investigation
 * documented the failure mode: without a probe the only recovery
 * path was `lsof -ti:PORT | xargs kill && pnpm dev:collab`.
 *
 * Contract:
 *
 * - `GET /healthz` - 200 `{status: 'ok', checks: {...}}` when every
 *   registered check resolves truthy in under {@link CHECK_TIMEOUT_MS};
 *   503 `{status: 'fail', checks: {...}}` otherwise.
 *   Per-check `ms` field shows latency so dashboards can graph
 *   trends (a slowly-drifting connection often shows up as
 *   creeping check latency before it outright fails).
 * - `GET /metrics` → 200 Prometheus text when an `onMetrics` hook is
 *   supplied; the application owns the registry and this library just
 *   serves the rendered string, so core stays dependency-free.
 * - Any other path → 404 (keep the surface tiny on purpose).
 *
 * The server runs on an isolated port so the main WS / queue port
 * isn't impacted by probe traffic, and so per-port failure
 * semantics in the LB stay clean.
 */

import { createServer, type Server } from "node:http";

/**
 * Per-check timeout - long enough to differentiate "slow but
 * recovering" from "stuck", short enough that a misbehaving probe
 * doesn't pile up if the LB hammers it every second.
 */
const CHECK_TIMEOUT_MS = 2000;

/**
 * A single health check. `name` is the JSON key the response
 * surfaces (`pg`, `redis_general`, etc.) - keep it short and
 * stable so dashboards can grep it. `check` resolves truthy for
 * healthy / throws or resolves falsy for unhealthy.
 */
export interface HealthCheck {
  name: string;
  check: () => Promise<boolean>;
}

export interface HealthServerOptions {
  /**
   * Port to listen on. Must NOT collide with the service's main
   * port (e.g. 1234 for collab WS).
   */
  port: number;
  /**
   * Service name tag forwarded to {@link HealthServerOptions.onEvent}
   * (`collab` / `worker`).
   */
  serviceName: string;
  /**
   * Dependencies to probe. Order does not matter; they're awaited
   * in parallel.
   */
  checks: HealthCheck[];
  /**
   * Optional observer for lifecycle events (listening, check
   * failures, unexpected handler errors).
   *
   * Per CLAUDE.md "core and shared must not log" mandate, this
   * library does NOT log directly - the application entry that
   * starts the server is responsible for routing observed events
   * to its own logger. If omitted, events are dropped silently
   * (acceptable for tests; production callers should always
   * provide this hook).
   */
  onEvent?: (event: HealthServerEvent) => void;
  /**
   * Optional `GET /metrics` handler. When supplied, the health server
   * also serves Prometheus exposition text at `/metrics` on the same
   * ops port. The library stays dependency-free: the application owns
   * the metrics registry and passes a function that renders it.
   * @returns the Prometheus text-format payload for one scrape
   */
  onMetrics?: () => Promise<string>;
}

/** Result of a single dependency probe. */
export interface CheckResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/** Lifecycle event surfaced via {@link HealthServerOptions.onEvent}. */
export type HealthServerEvent =
  | { type: "listening"; port: number; serviceName: string }
  | {
      type: "check_fail";
      serviceName: string;
      checks: Record<string, CheckResult>;
    }
  | {
      type: "handler_unexpected_error";
      serviceName: string;
      err: unknown;
    };

/**
 * Run one health check, racing it against {@link CHECK_TIMEOUT_MS}.
 * @param check - the dependency probe to run
 * @returns the check outcome with latency, marking it failed on throw or timeout
 */
async function runCheck(
  check: HealthCheck,
): Promise<CheckResult> {
  const started = Date.now();
  try {
    const result = await Promise.race([
      check.check(),
      new Promise<boolean>((_, reject) =>
        setTimeout(
          () => reject(new Error(`timeout after ${CHECK_TIMEOUT_MS}ms`)),
          CHECK_TIMEOUT_MS,
        ),
      ),
    ]);
    return { ok: Boolean(result), ms: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: (err as Error).message,
    };
  }
}

/**
 * Start a `/healthz` HTTP server for a long-lived service.
 * @param opts - port, service name, dependency checks, and optional event observer
 * @returns the running `server` plus a `stop` function that gracefully
 *   shuts it down; call `stop` from your SIGTERM handler.
 */
export function startHealthServer(opts: HealthServerOptions): {
  server: Server;
  stop: () => Promise<void>;
} {
  const { port, serviceName, checks, onEvent, onMetrics } = opts;

  const server = createServer((req, res) => {
    if (req.url === "/metrics" && onMetrics) {
      onMetrics()
        .then((body) => {
          res.statusCode = 200;
          res.setHeader("content-type", "text/plain; version=0.0.4");
          res.end(body);
        })
        .catch((err) => {
          onEvent?.({ type: "handler_unexpected_error", serviceName, err });
          res.statusCode = 500;
          res.end();
        });
      return;
    }
    if (req.url !== "/healthz") {
      res.statusCode = 404;
      res.end();
      return;
    }
    Promise.all(checks.map(runCheck))
      .then((results) => {
        const checksMap: Record<string, CheckResult> = {};
        let allOk = true;
        for (let i = 0; i < checks.length; i++) {
          checksMap[checks[i]!.name] = results[i]!;
          if (!results[i]!.ok) allOk = false;
        }
        res.statusCode = allOk ? 200 : 503;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            status: allOk ? "ok" : "fail",
            service: serviceName,
            checks: checksMap,
          }),
        );
        if (!allOk) {
          onEvent?.({ type: "check_fail", serviceName, checks: checksMap });
        }
      })
      .catch((err) => {
        // Should be unreachable - runCheck swallows per-check
        // failures into the CheckResult shape. 500 as a safety
        // net so we never silently leave the LB without a
        // response; the application caller routes the event to
        // its logger if observed.
        onEvent?.({ type: "handler_unexpected_error", serviceName, err });
        res.statusCode = 500;
        res.end();
      });
  });

  server.listen(port, () => {
    onEvent?.({ type: "listening", port, serviceName });
  });

  return {
    server,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
