/**
 * Health check HTTP server for long-lived services (collab, worker).
 *
 * Every long-lived service in the codebase must expose a `/healthz`
 * endpoint per the CLAUDE.md "服务器端工业级标准" mandate — a
 * docker / k8s / LB health probe with N-fail kill semantics is the
 * only mechanism that actually self-heals a process whose
 * downstream dependencies (PG pool, Redis connection) have drifted
 * silently. The 2026-05-27 long-running dev:collab investigation
 * documented the failure mode: without a probe the only recovery
 * path was `lsof -ti:PORT | xargs kill && pnpm dev:collab`.
 *
 * Contract:
 *
 * - `GET /healthz` — 200 `{status: 'ok', checks: {...}}` when every
 *   registered check resolves truthy in under {@link CHECK_TIMEOUT_MS};
 *   503 `{status: 'fail', checks: {...}}` otherwise.
 *   Per-check `ms` field shows latency so dashboards can graph
 *   trends (a slowly-drifting connection often shows up as
 *   creeping check latency before it outright fails).
 * - Any other path → 404 (keep the surface tiny on purpose; no
 *   metrics endpoint here — that's a separate concern).
 *
 * The server runs on an isolated port so the main WS / queue port
 * isn't impacted by probe traffic, and so per-port failure
 * semantics in the LB stay clean.
 */

import { createServer, type Server } from "node:http";
import { logger } from "../logger.js";

/** Per-check timeout — long enough to differentiate "slow but
 * recovering" from "stuck", short enough that a misbehaving probe
 * doesn't pile up if the LB hammers it every second. */
const CHECK_TIMEOUT_MS = 2000;

/**
 * A single health check. `name` is the JSON key the response
 * surfaces (`pg`, `redis_general`, etc.) — keep it short and
 * stable so dashboards can grep it. `check` resolves truthy for
 * healthy / throws or resolves falsy for unhealthy.
 */
export interface HealthCheck {
  name: string;
  check: () => Promise<boolean>;
}

export interface HealthServerOptions {
  /** Port to listen on. Must NOT collide with the service's main
   * port (e.g. 1234 for collab WS). */
  port: number;
  /** Service name tag for log lines (`collab` / `worker`). */
  serviceName: string;
  /** Dependencies to probe. Order does not matter; they're awaited
   * in parallel. */
  checks: HealthCheck[];
}

interface CheckResult {
  ok: boolean;
  ms: number;
  error?: string;
}

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
 *
 * @returns A function that gracefully shuts the server down; call
 *   it from your SIGTERM handler.
 */
export function startHealthServer(opts: HealthServerOptions): {
  server: Server;
  stop: () => Promise<void>;
} {
  const { port, serviceName, checks } = opts;

  const server = createServer((req, res) => {
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
          logger.warn(
            { service: serviceName, checks: checksMap },
            "healthz_fail",
          );
        }
      })
      .catch((err) => {
        // Should be unreachable — runCheck swallows per-check
        // failures into the CheckResult shape. Log + 500 as a
        // safety net so we never silently leave the LB without
        // a response.
        logger.error(
          { err, service: serviceName },
          "healthz_handler_unexpected_error",
        );
        res.statusCode = 500;
        res.end();
      });
  });

  server.listen(port, () => {
    logger.info({ service: serviceName, port }, "healthz_listening");
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
