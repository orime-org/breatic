// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A turn resumed by an answer to its card stays on the upstream that served it, so the deployment is asked about
 * that upstream before the answer is taken (#1363): with its key missing the request is refused and the card keeps
 * waiting.
 */

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ assertLlmServable: vi.fn(), answerAsk: vi.fn() }));

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
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
  const base = await serverModulesMock(importOriginal);
  return {
    ...base,
    conversationService: {
      ...base.conversationService,
      assertWritable: vi.fn().mockResolvedValue({ id: "conv-1" }),
      modelForMessage: vi.fn().mockResolvedValue("test"),
      modelForResume: vi.fn().mockResolvedValue({ modelId: "test", upstream: "deepseek" }),
      answerAsk: h.answerAsk,
    },
  };
});

vi.mock("@server/modules/task/model-servable.js", () => ({ assertLlmServable: h.assertLlmServable, assertServable: vi.fn() }));

import { AppError } from "@breatic/core";
import { createApp } from "../../app.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };

describe("a turn resumed by an answer to its card", () => {
  it("asks about the upstream it stays on, and refuses before the answer is taken", async () => {
    h.assertLlmServable.mockImplementation(() => {
      throw new AppError(503, "test is not set up on this deployment: it needs DEEPSEEK_API_KEY.");
    });

    const res = await createApp().request("/api/v1/chat/message", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        message: "",
        project_id: "11111111-1111-4111-8111-111111111111",
        conversation_id: "22222222-2222-4222-8222-222222222222",
        answer: { toolCallId: "call-1", answers: [] },
      }),
    });

    expect(res.status).toBe(503);
    expect(h.assertLlmServable).toHaveBeenCalledWith("test", "call", { mode: "upstream", upstream: "deepseek" });
    expect(h.answerAsk).not.toHaveBeenCalled();
  });
});
