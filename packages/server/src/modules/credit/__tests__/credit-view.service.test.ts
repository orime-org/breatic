// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/**
 * 一行流水，够 `toStudioLedgerView` 和游标各取所需。
 * @param id - 行 id，也是游标的 tie-breaker。
 * @param time - 当天的时刻，微秒级。
 * @returns 一行 repo 形状的流水。
 */
function ledgerRow(
  id: string,
  time: string,
): Record<string, unknown> {
  return {
    id,
    cursorAt: `2026-08-22 ${time}+00`,
    kind: "generation",
    actorUserId: null,
    actorName: null,
    projectId: null,
    projectName: null,
    model: null,
    provider: null,
    charged: "-10.000000",
    consumed: "-10.000000",
    owed: "0.000000",
    createdAt: new Date(`2026-08-22T${time.slice(0, 8)}Z`),
  };
}

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

    // One row over the page size is what tells a full page from a last one.
    expect(readStudioCredits).toHaveBeenCalledWith("s-1", 21);
    expect(listLedgerByStudio).not.toHaveBeenCalled();
  });

  it("reads only the ledger once the client is scrolling", async () => {
    // A continuation asks for one more page of ledger lines. The other three
    // figures are already on the client's screen and the request throws them
    // away — one of them is the studio's whole list of lots, which has no
    // limit and grows with every top-up it is ever given.
    await getStudioCredits("s-1", undefined, CURSOR);

    expect(readStudioCredits).not.toHaveBeenCalled();
    // The decoded cursor reaches the query. Dropping it here would serve the
    // first page forever, silently, to a client that is scrolling.
    expect(listLedgerByStudio).toHaveBeenCalledWith("s-1", 21, {
      createdAt: "2026-08-22 10:00:00.123456+00",
      id: "0b8f8a52-9f1c-4f6e-9a52-1c2d3e4f5a6b",
    });
  });

  it("carries the ledger page and its next cursor back out", async () => {
    // Two rows for a page of one: the extra says there is more. The cursor is
    // built from the last row the client actually receives, so the next page
    // continues from there rather than skipping the one held back.
    listLedgerByStudio.mockResolvedValue([
      ledgerRow("0b8f8a52-9f1c-4f6e-9a52-1c2d3e4f5a6b", "10:00:00.123456"),
      ledgerRow("1c9f9b63-af2d-5f7f-ab63-2d3e4f5a6b7c", "09:00:00.654321"),
    ]);

    const view = await getStudioCredits("s-1", "1", CURSOR);

    expect(view.ledger?.items).toHaveLength(1);
    expect(view.ledger?.items[0]).toMatchObject({ charged: -10 });
    expect(view.ledger?.nextCursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(view.ledger.nextCursor as string, "base64url").toString("utf8"),
    ) as { c: string; i: string };
    expect(decoded.c).toBe("2026-08-22 10:00:00.123456+00");
    expect(decoded.i).toBe("0b8f8a52-9f1c-4f6e-9a52-1c2d3e4f5a6b");
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
