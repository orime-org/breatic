/**
 * Mini-tools credit pre-check regression test (BUG-015).
 *
 * Verifies that mini-tool endpoints return 402 when user
 * has insufficient credits.
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

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const AUTH = { Authorization: "Bearer valid-token", "Content-Type": "application/json" };

describe("Mini-tools credit pre-check (BUG-015)", () => {
  beforeEach(() => {
    mocks.creditService.getBalance.mockReset();
    mocks.taskService.create.mockReset();
    mocks.taskService.create.mockResolvedValue({ id: "task-1", taskType: "image" });
  });

  it("rejects image tool with 402 when insufficient credits", async () => {
    mocks.creditService.getBalance.mockResolvedValue(0);

    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
      }),
    });

    expect(res.status).toBe(402);
  });

  it("allows image tool when credits sufficient", async () => {
    mocks.creditService.getBalance.mockResolvedValue(100);

    const app = createApp();
    const res = await app.request("/api/v1/mini-tools/image", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        tool: "remove-bg",
        image: "http://example.com/image.png",
      }),
    });

    expect(res.status).toBe(201);
  });
});
