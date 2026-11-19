// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Group totals are counted only for the first page of a Motion Space list: later pages and the Timeline picker's
 * results never read them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as CoreModule from "@breatic/core";

const { listPage, countGroups, findLiveExports, assertAccess } = vi.hoisted(() => ({
  listPage: vi.fn(),
  countGroups: vi.fn(),
  findLiveExports: vi.fn(),
  assertAccess: vi.fn(),
}));

vi.mock("@server/modules/web-animation/web-animation-grants.repo.js", () => ({
  listPage, countGroups, findLiveExports, BadCursorError: class BadCursorError extends Error {},
}));
vi.mock("@server/modules/project/project.service.js", () => ({ assertAccess }));
vi.mock("@breatic/domain", () => ({
  sumCreditsByOperationKeys: vi.fn(async () => new Map()),
  timelineOperationKey: (id: string) => `timeline:${id}`,
}));
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  getTimelineConfig: () => ({ assets: { page_size: 20, page_max: 50 } }),
}));

import { listResults, listSpace } from "@server/modules/web-animation/web-animation-execution.service.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SPACE = "22222222-2222-4222-8222-222222222222";
const TOTALS = { running: 1, succeeded: 2, failed: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  listPage.mockResolvedValue({ rows: [], nextCursor: null });
  countGroups.mockResolvedValue(TOTALS);
  findLiveExports.mockResolvedValue([]);
  assertAccess.mockResolvedValue(undefined);
});

describe("execution page totals", () => {
  it("answers the group counts on a Space list's first page", async () => {
    const page = await listSpace("u1", { projectId: PROJECT, spaceId: SPACE, scope: "space", group: "succeeded" });
    expect(page.totals).toEqual(TOTALS);
    expect(countGroups).toHaveBeenCalledTimes(1);
  });

  it("answers null without counting on a later page", async () => {
    const page = await listSpace("u1", { projectId: PROJECT, spaceId: SPACE, scope: "timeline", group: "running", cursor: "next" });
    expect(page.totals).toBeNull();
    expect(countGroups).not.toHaveBeenCalled();
  });

  it("answers null without counting for the Timeline picker's results", async () => {
    const page = await listResults("u1", { projectId: PROJECT });
    expect(page.totals).toBeNull();
    expect(countGroups).not.toHaveBeenCalled();
  });
});
