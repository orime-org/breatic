/**
 * Models route tests — public model catalog.
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

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

import { createApp } from "../../app.js";

describe("Models routes", () => {
  it("GET /models returns catalog without auth", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/models");

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toBeDefined();
  });

  it("GET /models sets cache header", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/models");

    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
  });
});
