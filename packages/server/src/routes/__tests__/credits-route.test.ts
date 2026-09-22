// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The trace the designation endpoint leaves when it refuses (task #267 B1).
 *
 * Pointing granted credits at another studio is the one refusal on this
 * endpoint that answers an attempt rather than a mistake, so the route writes
 * a line saying who asked, which purchase, and where they aimed. Nothing was
 * asserting that line, and the endpoint's own suite reaches the rule through
 * the service rather than through HTTP, so the handler's catch never ran.
 *
 * The service is a double here: what is under test is what the boundary
 * records and what it hands back, not the rule that refused.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { service, warn } = vi.hoisted(() => ({
  service: { designateLot: vi.fn() },
  warn: vi.fn(),
}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, creditLotService: service };
});

vi.mock("@server/middleware/rate-limit.js", () => ({
  rateLimitFor: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("@server/middleware/auth.js", () => ({
  requireAuth: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "user-1" });
    return next();
  },
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // `logger` too: it is a lazy singleton that reads env on first use, and the
  // line this suite is about is written through it.
  return {
    ...actual,
    logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
  };
});

import { Hono } from "hono";
import { initCore, loadLocales, ForbiddenError } from "@breatic/core";
import { errorHandler } from "@server/middleware/error-handler.js";
import creditsRoute from "@server/routes/credits.js";

try {
  initCore(process.env);
} catch {
  // Already initialised by a sibling suite in this worker.
}
loadLocales();

// Mounted the way `app.ts` mounts it, error handler included: what a refusal
// answers is decided by the pair rather than by the route alone.
const app = new Hono();
app.route("/", creditsRoute);
app.onError(errorHandler);

const LOT_ID = "11111111-1111-4111-8111-111111111111";
const STUDIO_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Asks the endpoint to point one purchase at one studio.
 * @param studioId - Where to aim it, or null to clear the designation.
 * @returns The response.
 */
async function designate(studioId: string | null): Promise<Response> {
  return app.request(`/lots/${LOT_ID}/designation`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ studioId }),
  });
}

beforeEach(() => {
  service.designateLot.mockReset();
  warn.mockReset();
});

/**
 * The lines the route itself wrote about a refusal.
 * @returns The fields of each, in the order they were written.
 */
function refusalLines(): Record<string, unknown>[] {
  return warn.mock.calls
    .filter((call) => call[1] === "credit_designation_refused")
    .map((call) => call[0] as Record<string, unknown>);
}

describe("what the designation endpoint records when it refuses", () => {
  it("names who asked, which purchase, and where they aimed", async () => {
    service.designateLot.mockRejectedValue(
      new ForbiddenError("granted credits stay where they were granted"),
    );

    const res = await designate(STUDIO_ID);

    expect(res.status).toBe(403);
    // Picked out by name: the error handler writes its own line for the same
    // refusal, and this suite is about the one the route writes.
    const lines = refusalLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      userId: "user-1",
      lotId: LOT_ID,
      studioId: STUDIO_ID,
    });
    // The error itself, so the line says which refusal it was rather than
    // only that one happened.
    expect(lines[0]).toHaveProperty("err");
  });

  it("records clearing a designation the same way, with no studio to name", async () => {
    // Refusing only the move would leave clearing as a way of doing it in two
    // steps, so the rule refuses both — and both are worth the same trace.
    service.designateLot.mockRejectedValue(
      new ForbiddenError("granted credits stay where they were granted"),
    );

    const res = await designate(null);

    expect(res.status).toBe(403);
    expect(refusalLines()).toEqual([
      expect.objectContaining({
        userId: "user-1",
        lotId: LOT_ID,
        studioId: null,
      }),
    ]);
  });

  it("writes nothing when the ask went through", async () => {
    service.designateLot.mockResolvedValue({
      id: LOT_ID,
      designatedStudioId: STUDIO_ID,
    });

    const res = await designate(STUDIO_ID);

    expect(res.status).toBe(200);
    expect(refusalLines()).toEqual([]);
  });
});
