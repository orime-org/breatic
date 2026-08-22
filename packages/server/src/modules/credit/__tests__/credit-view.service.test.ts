// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the studio credits endpoint reads, per request.
 *
 * The tab opens with four figures that have to agree with each other, and
 * scrolls with one. Which reads happen is the difference between a page that
 * loads once and a page that re-reads an unbounded list on every scroll.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const readStudioCredits = vi.fn();
const listLedgerByStudio = vi.fn();

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../../../__tests__/helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@breatic/domain", () => ({
  assetService: { resolveOwnerStudioId: vi.fn() },
  creditLotRepo: { listLedgerByStudio },
  creditLotService: { readStudioCredits },
}));

vi.mock("@server/config/limits.js", () => ({
  getCreditPageLimits: () => ({ default: 20, max: 100 }),
}));

const { getStudioCredits } = await import(
  "@server/modules/credit/credit-view.service.js"
);

/** A cursor of the shape the decoder accepts. */
const CURSOR = Buffer.from(
  JSON.stringify({
    c: "2026-08-22 10:00:00.123456+00",
    i: "0b8f8a52-9f1c-4f6e-9a52-1c2d3e4f5a6b",
  }),
).toString("base64url");

beforeEach(() => {
  vi.clearAllMocks();
  readStudioCredits.mockResolvedValue({
    spendable: 100,
    debt: 0,
    lots: [],
    ledger: [],
  });
  listLedgerByStudio.mockResolvedValue([]);
});

describe("GET a studio's credits", () => {
  it("takes the four figures from one snapshot on the first page", async () => {
    await getStudioCredits("s-1", undefined, undefined);

    expect(readStudioCredits).toHaveBeenCalledTimes(1);
    expect(listLedgerByStudio).not.toHaveBeenCalled();
  });

  it("reads only the ledger once the client is scrolling", async () => {
    // A continuation asks for one more page of ledger lines. The other three
    // figures are already on the client's screen and the request throws them
    // away — one of them is the studio's whole list of lots, which has no
    // limit and grows with every top-up it is ever given.
    await getStudioCredits("s-1", undefined, CURSOR);

    expect(readStudioCredits).not.toHaveBeenCalled();
    expect(listLedgerByStudio).toHaveBeenCalledTimes(1);
  });

  it("keeps the fields the tab opens with off a continuation", async () => {
    const view = await getStudioCredits("s-1", undefined, CURSOR);

    expect(view.spendable).toBeUndefined();
    expect(view.debt).toBeUndefined();
    expect(view.lots).toBeUndefined();
    expect(view.ledger).toBeDefined();
  });

  it("starts from the beginning when the cursor is unusable", async () => {
    const unusable = Buffer.from(
      JSON.stringify({ c: "2026-02-30 00:00:00+00", i: "not-a-uuid" }),
    ).toString("base64url");

    await getStudioCredits("s-1", undefined, unusable);

    expect(readStudioCredits).toHaveBeenCalledTimes(1);
    expect(listLedgerByStudio).not.toHaveBeenCalled();
  });
});
