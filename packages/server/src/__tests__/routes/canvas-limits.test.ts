// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Canvas limits route tests — the frontend-consumed reference-pool cap
 * knob (#1782): config/limits.yaml → GET /canvas/limits.
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
      data: { referencePoolCap: number };
    };
    expect(body.data.referencePoolCap).toBe(42);
  });
});
