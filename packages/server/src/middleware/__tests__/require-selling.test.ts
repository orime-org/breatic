// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The gate on a deployment that sells nothing — one test, two sentences.
 *
 * Both legs read whether a billing service is configured (`SELLING`), so the
 * test lives in one place. What they say when it is not is not shared: a
 * buyer refused a top-up must not be told memberships are unavailable. `t`
 * is mocked to return its key, so what these assertions pin is which key each
 * leg reaches for.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: { SELLING: true },
}));
vi.mock("@breatic/core", () => ({
  env: envMock,
  NotFoundError: class NotFoundError extends Error {},
}));
vi.mock("@breatic/shared", () => ({ t: (k: string) => k }));

import { requireSelling, requireSellingMemberships } from "@server/middleware/require-selling.js";

beforeEach(() => {
  envMock.SELLING = true;
});

describe("the gate on a deployment that sells nothing", () => {
  it("lets both legs through while a billing service is configured", async () => {
    const next = vi.fn(async () => undefined);

    await requireSelling({} as never, next);
    await requireSellingMemberships({} as never, next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it("tells the membership leg about memberships", () => {
    envMock.SELLING = false;
    const next = vi.fn();

    // Called directly: through an app the throw becomes whatever that app's
    // error handler makes of it, and the sentence is the thing being pinned.
    expect(() => requireSellingMemberships({} as never, next)).toThrow("server.membership.unavailable");
    expect(next).not.toHaveBeenCalled();
  });

  it("tells the credit leg about credits", () => {
    envMock.SELLING = false;
    const next = vi.fn();

    expect(() => requireSelling({} as never, next)).toThrow("server.payment.unavailable");
    expect(next).not.toHaveBeenCalled();
  });
});
