// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * P04 (inner#1006 §5): for any limit, size and way of sending, the body limit
 * answers 413 exactly when the body is larger than the limit, runs the route
 * exactly when it is not, hands the route the body unchanged, and reads at
 * most two chunks past the limit before refusing a chunked body.
 *
 * The limit comes from a mocked `getRequestBodyMaxBytes`, and the module is
 * loaded afresh for each run, so a middleware built at import time still sees
 * that run's limit.
 */

import fc from "fast-check";
import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

const { config, logged } = vi.hoisted(() => ({
  config: { limit: 1024 },
  logged: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@server/config/limits.js", () => ({
  getRequestBodyMaxBytes: () => config.limit,
}));

vi.mock("@server/middleware/session-cookie.js", () => ({
  readSessionCookie: () => undefined,
}));

vi.mock("@server/modules", () => ({ authService: { getUserByToken: vi.fn() } }));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: logged,
}));

import { LOOPBACK_PEER } from "@server/__tests__/helpers/peer.js";

/**
 * The middleware under test, loaded afresh for the current limit.
 * @returns The `requestBodyLimit` middleware.
 */
async function freshLimit(): Promise<MiddlewareHandler> {
  vi.resetModules();
  const mod = await import("@server/middleware/request-body-limit.js");
  return mod.requestBodyLimit;
}

/**
 * Deterministic body bytes of a given size.
 * @param size - How many bytes.
 * @returns The bytes.
 */
function bytesOf(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) % 251);
}

describe("P04: requestBodyLimit for any limit, size and sending mode", () => {
  it("413 iff size > limit; the route sees the exact body iff size <= limit; a chunked refusal reads at most two chunks past the limit", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 16, max: 4096 }).chain((limit) =>
          fc.record({
            limit: fc.constant(limit),
            // Within [0, 2 x limit], with the three sizes around the limit
            // drawn often: a uniform draw almost never lands on them.
            size: fc.oneof(fc.constantFrom(limit - 1, limit, limit + 1), fc.integer({ min: 0, max: 2 * limit })),
            mode: fc.constantFrom("content-length" as const, "chunked" as const),
            chunks: fc.array(fc.integer({ min: 1, max: 512 }), { minLength: 1, maxLength: 32 }),
          }),
        ),
        async ({ limit, size, mode, chunks }) => {
          config.limit = limit;
          const middleware = await freshLimit();
          const seen: Uint8Array[] = [];
          const app = new Hono();
          app.use("*", middleware);
          app.post("/x", async (c) => {
            seen.push(new Uint8Array(await c.req.arrayBuffer()));
            return c.text("ok");
          });

          const body = bytesOf(size);
          let pulled = 0;
          let request: Request;
          if (mode === "content-length") {
            request = new Request("http://localhost/x", {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) },
              body,
            });
          } else {
            let offset = 0;
            let index = 0;
            const stream = new ReadableStream<Uint8Array>({
              pull(controller) {
                if (offset >= size) {
                  controller.close();
                  return;
                }
                const length = Math.min(chunks[index % chunks.length]!, size - offset);
                index += 1;
                controller.enqueue(body.slice(offset, offset + length));
                offset += length;
                pulled += length;
              },
            });
            request = new Request("http://localhost/x", {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: stream,
              duplex: "half",
            } as RequestInit);
          }

          const res = await app.fetch(request, LOOPBACK_PEER);

          expect(res.status === 413).toBe(size > limit);
          if (size <= limit) {
            expect(res.status).toBe(200);
            expect(seen).toHaveLength(1);
            expect(Array.from(seen[0]!)).toEqual(Array.from(body));
          } else {
            expect(seen).toHaveLength(0);
            if (mode === "chunked") {
              expect(pulled).toBeLessThanOrEqual(limit + 2 * Math.max(...chunks));
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
