// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Skills route tests — built-in listing.
 */

import { describe, it, expect, vi } from "vitest";
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

const AUTH = { Cookie: "breatic_session=valid-token" };

describe("Skills routes", () => {
  it("GET /skills returns built-in skills", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/skills", { headers: AUTH });

    expect(res.status).toBe(200);
  });

  it("GET /skills requires auth", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/skills");

    expect(res.status).toBe(401);
  });
});
