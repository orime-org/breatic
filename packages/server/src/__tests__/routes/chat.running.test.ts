// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which conversations are running, as the routes see it (#1394).
 *
 * `GET /chat/running` answers the caller's own running conversations in one
 * project and nobody else's. A run holds its lease from its opening stage
 * until it has settled, renewed with its hold on the conversation; that half
 * is pinned in `integration/chat-running.integration.test.ts`.
 *
 * A query `validate()` refuses is answered 422 (`middleware/validate.ts`), as on
 * every other route.
 *
 * The lease module is doubled here; what it does against Redis is pinned by
 * `modules/conversation/__tests__/running-turns.service.integration.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

const { HEARTBEAT_MS, SILENCE_MS, PROJECT_ID, CONVERSATION_ID, lease } = vi.hoisted(() => {
  const state = {
    /** What this case's turn did with its lease, in order. */
    events: [] as string[],
    /**
     * One flag per lease held in this case, set when its release has
     * finished rather than when it was called. Per lease, and replaced for
     * every case, so a slow release left over from the previous case cannot
     * land on this one.
     */
    releases: [] as Array<{ done: boolean }>,
    holdError: null as Error | null,
    renewError: null as Error | null,
    releaseError: null as Error | null,
  };
  return {
    /** Short enough that a turn sees several beats. */
    HEARTBEAT_MS: 30,
    /** How long the model stays quiet before it says anything. */
    SILENCE_MS: 150,
    PROJECT_ID: "11111111-1111-4111-8111-111111111111",
    CONVERSATION_ID: "22222222-2222-4222-8222-222222222222",
    lease: {
      state,
      holdRunning: vi.fn(async (_scope: unknown) => {
        // Read once, at the hold, so a case that has already ended cannot
        // change what this lease does.
        const { events, holdError, renewError, releaseError } = state;
        const release = { done: false };
        state.releases.push(release);
        events.push("hold");
        if (holdError) throw holdError;
        return {
          renew: async (): Promise<void> => {
            events.push("renew");
            if (renewError) throw renewError;
          },
          release: async (): Promise<void> => {
            events.push("release");
            // Slow on purpose: a stream that closed without awaiting this
            // would close before `done` is set.
            await new Promise((r) => setTimeout(r, 100));
            if (releaseError) throw releaseError;
            release.done = true;
          },
        };
      }),
      runningConversationIds: vi.fn(async (_scope: unknown): Promise<string[]> => []),
    },
  };
});

vi.mock("@server/modules/conversation/running-turns.service.js", () => ({
  holdRunning: lease.holdRunning,
  runningConversationIds: lease.runningConversationIds,
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  return {
    ...base,
    getAgentConfig: () => ({ ...base.getAgentConfig(), sse_heartbeat_interval_ms: HEARTBEAT_MS }),
  };
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
      assertWritable: vi.fn().mockResolvedValue({ id: CONVERSATION_ID }),
      modelForMessage: vi.fn().mockResolvedValue("test"),
      modelForResume: vi.fn().mockResolvedValue("test"),
      getConversation: vi.fn().mockResolvedValue({ id: CONVERSATION_ID, lastConsolidatedTurn: 0 }),
      getMessagesForLlm: vi.fn().mockResolvedValue([]),
    },
  };
});

const { turn } = vi.hoisted(() => ({ turn: { fails: false } }));

vi.mock("@server/agent/main-agent.js", () => {
  /** A turn that thinks for a while and then speaks, or dies before it does. */
  async function* slowToStart(): AsyncGenerator<unknown> {
    await new Promise((resolve) => setTimeout(resolve, SILENCE_MS));
    if (turn.fails) throw new Error("the turn could not be assembled");
    yield { type: "text-delta", id: "t1", delta: "sorry, that took a moment" };
    yield { type: "finish" };
  }
  return {
    MainAgent: class {
      chat(): AsyncGenerator<unknown> {
        return slowToStart();
      }
    },
  };
});

import { createApp } from "../../app.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const SIGNED_IN_USER = "user-1";

/**
 * Ask which conversations are running.
 * @param query - The query string, without the `?`.
 * @returns The response.
 */
function askRunning(query: string): Promise<Response> {
  return Promise.resolve(createApp().request(`/api/v1/chat/running?${query}`, { headers: AUTH }));
}

beforeEach(() => {
  vi.clearAllMocks();
  lease.state.events = [];
  lease.state.releases = [];
  lease.state.holdError = null;
  lease.state.renewError = null;
  lease.state.releaseError = null;
  turn.fails = false;
});

describe("GET /chat/running", () => {
  it("answers the running conversations of the signed-in user in the asked project", async () => {
    lease.runningConversationIds.mockResolvedValueOnce(["conv-a", "conv-b"]);

    const res = await askRunning(`project_id=${PROJECT_ID}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { conversation_ids: ["conv-a", "conv-b"] } });
    expect(lease.runningConversationIds).toHaveBeenCalledTimes(1);
    expect(lease.runningConversationIds).toHaveBeenCalledWith({ userId: SIGNED_IN_USER, projectId: PROJECT_ID });
  });

  it("reads the caller's own leases even when the query names another user", async () => {
    const res = await askRunning(`project_id=${PROJECT_ID}&user_id=33333333-3333-4333-8333-333333333333`);

    expect(res.status).toBe(200);
    expect(lease.runningConversationIds).toHaveBeenCalledWith({ userId: SIGNED_IN_USER, projectId: PROJECT_ID });
  });

  it("refuses a request with no project_id, without reading anything", async () => {
    const res = await askRunning("");

    expect(res.status).toBe(422);
    expect(lease.runningConversationIds).not.toHaveBeenCalled();
  });

  it("refuses a project_id that is not a uuid, without reading anything", async () => {
    const res = await askRunning("project_id=not-a-uuid");

    expect(res.status).toBe(422);
    expect(lease.runningConversationIds).not.toHaveBeenCalled();
  });

  it("answers 500 when the leases cannot be read", async () => {
    lease.runningConversationIds.mockRejectedValueOnce(new Error("redis unavailable"));

    const res = await askRunning(`project_id=${PROJECT_ID}`);

    expect(res.status).toBe(500);
  });
});
