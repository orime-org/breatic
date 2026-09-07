// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The gate on a deployment that sells nothing — one test, two sentences.
 *
 * Both legs read the same flag, so the test lives in one place. What they say
 * when it is off is not shared: a buyer refused a top-up must not be told
 * memberships are unavailable. `t` is mocked to return its key, so what these
 * assertions pin is which key each leg reaches for.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: { PAYMENT_ENABLED: true },
}));
vi.mock("@breatic/core", () => ({
  env: envMock,
  NotFoundError: class NotFoundError extends Error {},
}));
vi.mock("@breatic/shared", () => ({ t: (k: string) => k }));

import { Hono } from "hono";
import {
  assertPaymentsEnabled,
  requirePayments,
} from "@server/middleware/require-payments.js";

beforeEach(() => {
  envMock.PAYMENT_ENABLED = true;
});

describe("the gate on a deployment that sells nothing", () => {
  it("lets both legs through while payments are on", async () => {
    expect(() => {
      assertPaymentsEnabled();
    }).not.toThrow();

    const app = new Hono();
    app.use("*", requirePayments);
    app.get("/", (c) => c.text("ok"));
    expect((await app.request("/")).status).toBe(200);
  });

  it("tells the membership leg about memberships", () => {
    envMock.PAYMENT_ENABLED = false;
    expect(() => {
      assertPaymentsEnabled();
    }).toThrow("server.membership.unavailable");
  });

  it("tells the credit leg about credits", () => {
    envMock.PAYMENT_ENABLED = false;
    const next = vi.fn();

    // Called directly: through an app the throw becomes whatever that app's
    // error handler makes of it, and the sentence is the thing being pinned.
    expect(() => requirePayments({} as never, next)).toThrow(
      "server.payment.unavailable",
    );
    expect(next).not.toHaveBeenCalled();
  });
});
