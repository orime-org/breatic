// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The first ring of the stop chain: the route notices the client leaving.
 *
 * Both streaming chat entrances are covered, because a stop that only works on
 * one of them is a route the user cannot get out of.
 *
 * The client going away is reproduced by cancelling the response body, which
 * is the same path a real disconnect takes. Measured on this repo's
 * hono 4.12.23 and @hono/node-server 2.0.4: the `stream()` helper only
 * subscribes to `c.req.raw.signal` on old Bun, so on Node the only route to
 * `StreamingApi.abort()` is the response readable's `cancel` callback, and
 * node-server calls it from `writable.on("close", ...)` when the socket goes.
 * A probe against a real server confirmed `s.onAbort` fires.
 *
 * What that probe also showed is why this ring alone settles nothing: with the
 * callback firing, the turn's generator still ran 357 more iterations and its
 * `finally` was never entered, because nothing connected the callback to the
 * turn. So the assertion here is not that `onAbort` fired — it is that the
 * signal the turn was handed is the one that gets raised.
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
      getConversation: vi.fn().mockResolvedValue({ id: "conv-1", lastConsolidatedTurn: 0 }),
      getMessagesForLlm: vi.fn().mockResolvedValue([]),
    },
  };
});

/** The signals handed to the agent, one per turn started. */
const handedSignals: Array<AbortSignal | undefined> = [];

vi.mock("@server/agent/main-agent.js", () => {
  /** A turn that streams forever until someone stops it. */
  async function* endless(signal?: AbortSignal): AsyncGenerator<unknown> {
    handedSignals.push(signal);
    for (;;) {
      yield { event: "chat_chunk", data: { text: "." } };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return {
    MainAgent: class {
      chat(_msg: string, _resources?: string[], signal?: AbortSignal): AsyncGenerator<unknown> {
        return endless(signal);
      }
      handleSkillCommand(
        _skill: string,
        _input: string,
        _resources?: string[],
        signal?: AbortSignal,
      ): AsyncGenerator<unknown> {
        return endless(signal);
      }
    },
  };
});

import { createApp } from "../../app.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

const ENTRANCES = [
  {
    name: "POST /chat/message",
    path: "/api/v1/chat/message",
    body: {
      message: "hi",
      project_id: PROJECT_ID,
      conversation_id: CONVERSATION_ID,
    },
  },
  {
    name: "POST /chat/skill",
    path: "/api/v1/chat/skill",
    body: {
      skill_name: "creative_research",
      input: "hi",
      project_id: PROJECT_ID,
      conversation_id: CONVERSATION_ID,
    },
  },
];

beforeEach(() => {
  handedSignals.length = 0;
});

describe("a client that goes away mid-stream", () => {
  for (const entrance of ENTRANCES) {
    it(`raises the signal the turn was handed, from ${entrance.name}`, async () => {
      const app = createApp();
      const res = await app.request(entrance.path, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(entrance.body),
      });
      expect(res.status).toBe(200);

      // Read one chunk, so the turn is genuinely under way before the client
      // leaves. A cancel before the first read would not tell us whether the
      // wiring survives a stream in flight.
      const reader = res.body?.getReader();
      expect(reader).toBeDefined();
      await reader?.read();

      const signal = handedSignals[0];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      await reader?.cancel();
      // The subscriber list runs synchronously inside `abort()`, but the read
      // side needs a turn of the loop to get there.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(signal?.aborted).toBe(true);
    });
  }
});
