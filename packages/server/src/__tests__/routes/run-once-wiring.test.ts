// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every run-once route goes through `runOnce` (inner#1490): a valid request
 * without an `Idempotency-Key` is refused before its handler runs. What the
 * middleware does with a key is covered against a real Redis in
 * `middleware/__tests__/run-once.integration.test.ts`.
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

import { t } from "@breatic/shared";
import { createApp } from "../../app.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";
const NODE = "33333333-3333-4333-8333-333333333333";

/** Each run-once route with a body its validator accepts. */
const ROUTES: ReadonlyArray<{ path: string; body: Record<string, unknown> }> = [
  {
    path: "/api/v1/canvas/tasks",
    body: {
      task_type: "image",
      params: { prompt: "a cat" },
      model: "test-model",
      source: "task",
      project_id: PID,
      space_id: SID,
      mode: "append",
    },
  },
  {
    path: "/api/v1/canvas/understand",
    body: {
      project_id: PID,
      space_id: SID,
      source_type: "image",
      source_url: "https://assets.invalid/image/a.png",
      node_ids: [NODE],
    },
  },
  {
    path: "/api/v1/mini-tools",
    body: {
      project_id: PID,
      space_id: SID,
      slots: {},
      tool: "image.upscale",
      node_ids: [NODE],
      source: { url: "https://assets.example.com/i/a.png" },
      params: { target_megapixels: 16, creativity: 2 },
    },
  },
  { path: "/api/v1/chat/conversations", body: { project_id: PID } },
  {
    path: "/api/v1/account/subscription/checkout",
    body: { tier: "pro", period: "month", return_url: "https://app.example.com/back" },
  },
  { path: "/api/v1/account/subscription/change", body: { tier: "pro", period: "year" } },
  { path: "/api/v1/projects", body: { studioId: PID, name: "My Project", slug: "my-project" } },
  {
    path: "/api/v1/payment/checkout",
    body: {
      price_cents: 1000,
      return_url: "https://app.example.com/back",
      time_zone: "UTC",
      consented: true,
    },
  },
];

describe("run-once routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(ROUTES)("$path refuses a press without an Idempotency-Key", async ({ path, body }) => {
    const res = await createApp().request(path, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { message: string } };
    expect(payload.error.message).toBe(t("server.idempotency.missing"));
  });

  it.each(ROUTES)("$path refuses a malformed Idempotency-Key", async ({ path, body }) => {
    const res = await createApp().request(path, {
      method: "POST",
      headers: { ...AUTH, "Idempotency-Key": "has spaces" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(422);
  });
});
