// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A turn that fails before the model is even asked still says so.
 *
 * The work a turn does before it starts talking -- storing the message,
 * handing back the conversation, reading the three memories, compressing the
 * history, assembling the agent -- all of it can fail: a database round trip,
 * a config that will not load. It happens inside the stream, and a stream that
 * simply ends looks to the browser exactly like a turn that finished: the
 * reply slot stops being written to and nothing says why.
 *
 * So the failure has to leave two marks. One goes to the reader, who gets the
 * same one line every other failure gets and can press send again. The other
 * goes to the log, with the three things that say whose turn this was --
 * without them the entry is a stack trace nobody can trace back to anyone.
 */

import { describe, it, expect, vi } from "vitest";

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

vi.mock("@server/agent/main-agent.js", () => {
  /** A turn that dies on its way to the model, before a word goes out. */
  // eslint-disable-next-line require-yield -- it throws instead of yielding, which is the case.
  async function* diesEarly(): AsyncGenerator<unknown> {
    throw new Error("the memory store is down");
  }
  return {
    MainAgent: class {
      chat(): AsyncGenerator<unknown> {
        return diesEarly();
      }
      handleSkillCommand(): AsyncGenerator<unknown> {
        return diesEarly();
      }
    },
  };
});

import { mocks } from "../helpers/mock-core.js";
import { createApp } from "../../app.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

describe("a turn that fails before the model is asked", () => {
  it("tells the reader, instead of ending the stream as if it had finished", async () => {
    const app = createApp();

    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        message: "hi",
        project_id: PROJECT_ID,
        conversation_id: CONVERSATION_ID,
      }),
    });
    const wire = await res.text();

    // A clean end is what a finished turn looks like, so the browser would
    // leave an empty reply on screen with nothing to explain it.
    expect(wire).toContain("event: error");
  });

  it("logs it with the three things that say whose turn it was", async () => {
    mocks.logger.error.mockClear();
    const app = createApp();

    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        message: "hi",
        project_id: PROJECT_ID,
        conversation_id: CONVERSATION_ID,
      }),
    });
    await res.text();

    // Left to the framework, this comes out as a bare `console.error` with the
    // stack and nothing else -- no user, no conversation, no project. At three
    // in the morning that entry cannot be traced back to anyone.
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        // The one the service confirmed writable, which is what the turn ran
        // against -- not the id the request happened to carry.
        conversationId: "conv-1",
        projectId: PROJECT_ID,
        userId: expect.any(String),
      }),
      expect.any(String),
    );
  });
});
