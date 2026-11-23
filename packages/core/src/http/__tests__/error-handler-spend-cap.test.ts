// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A spend-limit refusal crosses the wire with what the web client builds its
 * sentence from (inner#1968, design 3.10): `reason`, `scope`, `limit` and
 * `resetsAt` beside the code and message.
 */

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { SpendCapReachedError } from "../../app-errors.js";
import { createErrorHandler } from "../error-handler.js";

describe("the error handler on a spend-limit refusal", () => {
  it.each([
    ["member", "50.000000"],
    ["studio", "500.000000"],
  ] as const)("answers 402 with the %s limit, its amount and the reset", async (scope, limit) => {
    const report = vi.fn();
    const app = new Hono();
    app.onError(createErrorHandler({ report }));
    const resetsAt = "2026-12-01T00:00:00.000Z";
    app.get("/", () => {
      throw new SpendCapReachedError({ scope, limit, resetsAt });
    });

    const res = await app.request("/");

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ code: 402, reason: "spend_cap_reached", scope, limit, resetsAt });
    expect(typeof body.error.message).toBe("string");
    expect(report).not.toHaveBeenCalled();
  });
});
