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
