// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The internal API's request authentication (inner#1410 §4.2): the signature
 * checks in `internal-signature.ts`, then the nonce, which needs Redis. Any
 * failed step is 401 `{ code: "unauthorized" }`; Redis unavailable is 503,
 * never let through.
 */

import type { MiddlewareHandler } from "hono";
import type { Redis } from "ioredis";
import { WINDOW_SECONDS, verifyInternalRequest } from "@core/http/internal-signature.js";

/**
 * How long a nonce is remembered. The window compares whole seconds and
 * includes both ends, so a timestamp `ts` is accepted from `ts - 300` until
 * just before `ts + 301` (the floor adds that last second); counting from the
 * first acceptance, that is at most 601 seconds, kept one more for margin.
 */
const NONCE_TTL_SECONDS = 2 * WINDOW_SECONDS + 2;

declare module "hono" {
  interface ContextVariableMap {
    /** The back office admin an internal API request acts for. */
    internalAdmin: string;
    /** The operator's reason a write request gave, for its log line. */
    internalReason: string;
  }
}

/** What the authentication tells its service to log; core itself never logs. */
export type InternalAuthEvent =
  | { kind: "rejected"; step: string; path: string }
  | { kind: "nonce_unavailable"; err: unknown };

/** What a service hands {@link createInternalAuth} for one listener. */
export interface InternalAuthDeps {
  /** The secrets this listener accepts: the current one and, during rotation, the previous one (empty otherwise). */
  secrets: () => { current: string; previous: string };
  /** The service's Redis (DB0), where nonces are remembered. */
  redis: () => Redis;
  /** The first segment of the nonce key (the deployment's `ENV`). */
  keyPrefix: () => string;
  /** Log one event. */
  report: (event: InternalAuthEvent) => void;
}

/**
 * Build one listener's request authentication.
 * @param deps - The accepted secrets, Redis, the key prefix and the log sink.
 * @returns `internalAuth()`, the middleware factory.
 */
export function createInternalAuth(deps: InternalAuthDeps): () => MiddlewareHandler {
  /**
   * Refuse any request that is not signed by the back office, or that repeats
   * a nonce. Sets `internalAdmin` for the handlers.
   * @returns The middleware.
   */
  function internalAuth(): MiddlewareHandler {
    return async (c, next) => {
      const url = new URL(c.req.url);
      const verdict = verifyInternalRequest(
        {
          method: c.req.method,
          pathWithQuery: `${url.pathname}${url.search}`,
          headers: {
            "x-internal-admin": c.req.header("x-internal-admin"),
            "x-internal-timestamp": c.req.header("x-internal-timestamp"),
            "x-internal-nonce": c.req.header("x-internal-nonce"),
            "x-internal-signature": c.req.header("x-internal-signature"),
            "idempotency-key": c.req.header("idempotency-key"),
          },
          body: await c.req.text(),
        },
        deps.secrets(),
        Math.floor(Date.now() / 1000),
      );
      if (!verdict.ok) {
        deps.report({ kind: "rejected", step: verdict.step, path: c.req.path });
        return c.json({ code: "unauthorized" }, 401);
      }
      let fresh: string | null;
      try {
        fresh = await deps.redis().set(
          `${deps.keyPrefix()}:server:internal-nonce:${verdict.nonce}`,
          "1",
          "EX",
          NONCE_TTL_SECONDS,
          "NX",
        );
      } catch (err) {
        deps.report({ kind: "nonce_unavailable", err });
        return c.json({ code: "unavailable" }, 503);
      }
      if (fresh === null) {
        deps.report({ kind: "rejected", step: "nonce", path: c.req.path });
        return c.json({ code: "unauthorized" }, 401);
      }
      c.set("internalAdmin", verdict.adminId);
      await next();
    };
  }

  return internalAuth;
}
