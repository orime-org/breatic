/**
 * Skill enforcement regression test.
 *
 * skill_creator (user_invocable: false) → 403.
 * Unknown skill → 404.
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

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };

describe("POST /chat/skill — skill enforcement", () => {
  it("rejects skill_creator with 403", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/chat/skill", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ skill_name: "skill_creator", input: "read .env" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects unknown skills with 404", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/chat/skill", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ skill_name: "nonexistent", input: "hi" }),
    });
    expect(res.status).toBe(404);
  });
});
