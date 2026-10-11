// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When an upload's two hours run out (inner#1367 §4.8c): off its node's task
 * row when it has one, off its grant's opening when it does not. The status
 * query hands in the grant it already holds, and reads none again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findByStorageKey = vi.fn();
const findGrantByKey = vi.fn();
const findOwnGrants = vi.fn();

vi.mock("@domain/node-task/node-task.service.js", () => ({ findByStorageKey }));
vi.mock("@domain/asset/upload-grant.repo.js", () => ({ findGrantByKey, findOwnGrants }));
vi.mock("@domain/asset/asset.repo.js", () => ({ findById: vi.fn() }));
vi.mock("@breatic/core", () => ({
  budgetDeadlineFrom: (startedAt: number): number => startedAt + 7_200_000,
}));

const { uploadDeadline, uploadDeadlineByKey } = await import("@domain/asset/upload-deadline.js");
const { statusOf } = await import("@domain/asset/upload-status.service.js");

const GRANT = {
  storageKey: "image/2026-10-11/1_x.jpg",
  createdAt: new Date(1_000_000),
  consumedAt: null,
  voidedAt: null,
  assetId: null,
  failureReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("uploadDeadline", () => {
  it("ends with the node's task row when there is one", async () => {
    findByStorageKey.mockResolvedValue({ startedAt: new Date(5_000), budgetMs: 60_000 });
    await expect(uploadDeadline(GRANT)).resolves.toBe(65_000);
  });

  it("counts the budget from the grant's opening when there is no row", async () => {
    findByStorageKey.mockResolvedValue(null);
    await expect(uploadDeadline(GRANT)).resolves.toBe(1_000_000 + 7_200_000);
    expect(findGrantByKey).not.toHaveBeenCalled();
  });
});

describe("uploadDeadlineByKey", () => {
  it("reads the grant on the key, then its deadline", async () => {
    findGrantByKey.mockResolvedValue(GRANT);
    findByStorageKey.mockResolvedValue(null);
    await expect(uploadDeadlineByKey(GRANT.storageKey)).resolves.toBe(8_200_000);
  });

  it("refuses a key no grant was opened on", async () => {
    findGrantByKey.mockResolvedValue(null);
    await expect(uploadDeadlineByKey("nope")).rejects.toThrow("no upload grant on nope");
  });
});

describe("the status of an upload still finishing", () => {
  it("is judged off the grant the query already holds", async () => {
    findOwnGrants.mockResolvedValue([GRANT]);
    findByStorageKey.mockResolvedValue(null);
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);

    await expect(statusOf("user-1", [GRANT.storageKey])).resolves.toEqual([
      { key: GRANT.storageKey, state: "finishing" },
    ]);
    expect(findGrantByKey).not.toHaveBeenCalled();
  });
});
