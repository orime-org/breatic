// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Refunds are global data (inner#1955): only the global region's server runs
 * the refund loop, even when another region runs the internal API too.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  env: { INTERNAL_API_ENABLED: true, REGION: "sg", GLOBAL_REGION: "us-west" },
  sendDueRefundMails: vi.fn(async () => undefined),
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: h.env,
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@server/config/credit-refund.js", () => ({ getCreditRefundConfig: () => ({ loopIntervalSeconds: 60 }) }));
vi.mock("@server/modules/credit-refund/refund-mail.js", () => ({
  sendDueRefundMails: h.sendDueRefundMails,
  markStaleRefundMailsUnknown: vi.fn(async () => undefined),
}));
vi.mock("@server/modules/credit-refund/reconcile.js", () => ({ runDailyReconcile: vi.fn(async () => undefined) }));

const { startRefundLoop } = await import("@server/modules/credit-refund/refund-loop.js");

afterEach(() => {
  h.env.REGION = "sg";
  h.sendDueRefundMails.mockClear();
});

describe("startRefundLoop and the region", () => {
  it("runs nothing outside the global region", async () => {
    const loop = startRefundLoop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await loop.stop();

    expect(h.sendDueRefundMails).not.toHaveBeenCalled();
  });

  it("runs in the global region", async () => {
    h.env.REGION = "us-west";
    const loop = startRefundLoop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await loop.stop();

    expect(h.sendDueRefundMails).toHaveBeenCalled();
  });
});
