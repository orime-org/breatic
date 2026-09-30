// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas limits route tests — the knobs the frontend reads before it can
 * gate anything (#1782, #2175): config yaml → GET /canvas/limits.
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

// The route layer only translates HTTP → the config accessor, so the
// accessor is mocked here (the loader itself — real yaml read + schema —
// is covered by src/config/__tests__/limits.test.ts; the core mock points
// MONOREPO_ROOT at /tmp, so the real loader cannot run in this harness).
vi.mock("../../config/limits.js", () => ({
  getCanvasReferencePoolCap: vi.fn(() => 42),
  getNodeHistoryPageSize: vi.fn(() => 15),
  getUnderstandConfig: vi.fn(() => ({ max_media_bytes: 20_971_520 })),
}));

import { createApp } from "../../app.js";

const AUTH = { Cookie: "breatic_session=valid-token" };

describe("GET /canvas/limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires auth", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/canvas/limits");
    expect(res.status).toBe(401);
  });

  it("serves exactly what the limits accessor returns", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/canvas/limits", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        referencePoolCap: number;
        nodeHistoryPageSize: number;
        understandMaxBytes: number;
      };
    };
    expect(body.data.referencePoolCap).toBe(42);
    expect(body.data.nodeHistoryPageSize).toBe(15);
    // The browser refuses a file over this before it builds anything, and its
    // toast says the number — so the number has to reach it, and it comes
    // from the same file the run itself reads.
    expect(body.data.understandMaxBytes).toBe(20_971_520);
  });
});
