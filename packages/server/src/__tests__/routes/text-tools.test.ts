/**
 * Text tools route tests — SSE streaming text operations.
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

const AUTH = { Authorization: "Bearer valid-token", "Content-Type": "application/json" };

describe("Text tools routes", () => {
  it("POST /mini-tools/text requires auth", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "polish", document: "hello" }),
    });

    expect(res.status).toBe(401);
  });

  it("POST /mini-tools/text rejects invalid tool with 400", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/text", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ tool: "nonexistent-tool", document: "hello" }),
    });

    expect(res.status).toBe(400);
  });
});
