// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `GET /studio/:slug/projects` — reading the list, sort and page from the
 * query and the reader's language from the request.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const AUTH = { Cookie: "breatic_session=valid-token" };
const EMPTY_PAGE = { items: [], nextCursor: null, total: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectService.listByStudioSlug.mockResolvedValue(EMPTY_PAGE);
});

describe("GET /studio/:slug/projects", () => {
  it("passes the sort, cursor, page size and the reader's language to the service", async () => {
    const res = await createApp().request(
      "/api/v1/studio/acme/projects?sort=name&cursor=abc&limit=20",
      { headers: { ...AUTH, "Accept-Language": "zh-CN" } },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: EMPTY_PAGE });
    expect(mocks.projectService.listByStudioSlug).toHaveBeenCalledWith("acme", "user-1", {
      archived: false,
      sort: "name",
      cursor: "abc",
      limit: 20,
      locale: "zh-CN",
      onRejectedCursor: expect.any(Function),
    });
  });

  it("logs who sent a cursor the service could not read", async () => {
    mocks.projectService.listByStudioSlug.mockImplementation(
      async (_slug: string, _user: string, options: { onRejectedCursor?: () => void }) => {
        options.onRejectedCursor?.();
        return EMPTY_PAGE;
      },
    );
    const res = await createApp().request("/api/v1/studio/acme/projects?sort=name&cursor=forged", {
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { userId: "user-1", slug: "acme", sort: "name" },
      "studio_project_list_cursor_rejected",
    );
  });

  it("refuses a sort the live list does not offer with 422", async () => {
    const res = await createApp().request("/api/v1/studio/acme/projects?sort=archived", {
      headers: AUTH,
    });

    expect(res.status).toBe(422);
    expect(mocks.projectService.listByStudioSlug).not.toHaveBeenCalled();
  });

  it("refuses a sort the archived list does not offer with 422", async () => {
    const res = await createApp().request("/api/v1/studio/acme/projects?archived=true&sort=opened", {
      headers: AUTH,
    });

    expect(res.status).toBe(422);
    expect(mocks.projectService.listByStudioSlug).not.toHaveBeenCalled();
  });

  it("refuses a page size that is not a positive whole number with 422", async () => {
    const res = await createApp().request("/api/v1/studio/acme/projects?limit=abc", {
      headers: AUTH,
    });

    expect(res.status).toBe(422);
    expect(mocks.projectService.listByStudioSlug).not.toHaveBeenCalled();
  });
});
