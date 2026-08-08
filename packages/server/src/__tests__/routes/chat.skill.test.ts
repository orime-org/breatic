// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Skill enforcement regression test.
 *
 * A skill the routing config does not let a user fire → 403.
 * Unknown skill → 404.
 *
 * The registry no longer answers the first question — moving that answer out
 * of skill metadata and into `config/skill-routing.yaml` is what this change
 * is for. The registry is only asked whether the skill exists at all.
 *
 * The 403 case names a fixture rather than a real skill on purpose. It used
 * to name the one skill that happened to be gated, so deleting that skill
 * would have left the test green while guarding nothing. What is under test
 * is the gate, not any particular skill's metadata.
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

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };

describe("POST /chat/skill — skill enforcement", () => {
  it("rejects a skill that is not user-invocable with 403", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/chat/skill", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ skill_name: "gated_fixture", input: "go" }),
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
