// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reader's time zone, from the request body to the turn.
 *
 * The browser reports it with every message; the route hands it to the agent
 * as it came, and the agent decides what an unknown one means.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
    },
  };
});

/** The time zone each started turn was handed. */
const handedZones: Array<string | undefined> = [];

vi.mock("@server/agent/main-agent.js", () => ({
  MainAgent: class {
    async chat(
      _said: string,
      _signal?: AbortSignal,
      _chips?: unknown,
      timeZone?: string,
    ): Promise<ReadableStream<unknown>> {
      handedZones.push(timeZone);
      return new ReadableStream<unknown>({
        start(controller) {
          controller.close();
        },
      });
    }
  },
}));

import { createApp } from "../../app.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const BODY = {
  message: "what time is it?",
  project_id: "11111111-1111-4111-8111-111111111111",
  conversation_id: "22222222-2222-4222-8222-222222222222",
};

/**
 * Post one message and read the response to its end.
 * @param body - The request body.
 * @returns The response status.
 */
async function post(body: Record<string, unknown>): Promise<number> {
  const res = await createApp().request("/api/v1/chat/message", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

beforeEach(() => {
  handedZones.length = 0;
});

describe("POST /chat/message and the reader's time zone", () => {
  it("hands the zone the browser reported to the turn", async () => {
    expect(await post({ ...BODY, time_zone: "Asia/Shanghai" })).toBe(200);
    expect(handedZones).toEqual(["Asia/Shanghai"]);
  });

  it("starts the turn without a zone when none was sent", async () => {
    expect(await post(BODY)).toBe(200);
    expect(handedZones).toEqual([undefined]);
  });

  it("refuses a zone longer than any IANA name", async () => {
    expect(await post({ ...BODY, time_zone: "x".repeat(65) })).toBe(422);
    expect(handedZones).toEqual([]);
  });
});
