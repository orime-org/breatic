// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chat stream says it is alive while the model is quiet.
 *
 * A turn can spend a long time producing nothing the user can see -- a slow
 * first token, a tool the model is waiting on. On the wire that is
 * indistinguishable from a connection that died: same silence, same open
 * socket. The browser cannot tell them apart by looking, so without something
 * arriving on a schedule its only options are to wait forever on a dead
 * stream or to give up on a live one.
 *
 * So the server sends a frame of its own on a timer. It carries nothing --
 * its arrival is the whole message -- and the client that has not seen one
 * for three intervals treats the stream as gone.
 *
 * The frame is a transient data part: `{ type: 'data-heartbeat', transient:
 * true }`. Transient is what keeps it out of the message -- the SDK hands
 * such a chunk to `onData` and stops, so it never reaches the parts that get
 * stored and rendered. The stream carries the SDK's own chunk types now, so
 * a beat is read off the `data:` line like everything else; there is no
 * `event:` line on this wire.
 *
 * The real interval is five seconds, which would make this suite take a
 * minute to watch a handful go by, so it is shortened here. What is being
 * tested is that the frames are produced on whatever that interval is, not
 * the figure itself -- the figure is one shared declaration read by both
 * sides, and a test that restated it would only be asserting the constant
 * equals itself.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

// Hoisted, because both are read by `vi.mock` factories, which run before the
// file's own top-level statements.
const { HEARTBEAT_MS, SILENCE_MS } = vi.hoisted(() => ({
  /** Short enough that a test can watch several go by. */
  HEARTBEAT_MS: 30,
  /** How long the model stays quiet before it says anything. */
  SILENCE_MS: 150,
}));

vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SSE_HEARTBEAT_INTERVAL_MS: HEARTBEAT_MS,
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

vi.mock("@server/agent/main-agent.js", () => {
  /** A turn that thinks for a while and only then speaks. */
  async function* slowToStart(): AsyncGenerator<unknown> {
    await new Promise((resolve) => setTimeout(resolve, SILENCE_MS));
    yield { event: "chat_chunk", data: { text: "sorry, that took a moment" } };
    yield { event: "chat_done", data: {} };
  }
  return {
    MainAgent: class {
      chat(): AsyncGenerator<unknown> {
        return slowToStart();
      }
      handleSkillCommand(): AsyncGenerator<unknown> {
        return slowToStart();
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
    body: { message: "hi", project_id: PROJECT_ID, conversation_id: CONVERSATION_ID },
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

/**
 * The frames on a stream, in arrival order.
 *
 * Every frame the SDK writes is a `data:` line holding one chunk, and the
 * chunk names itself in a `type` field. There is no `event:` line to read:
 * `JsonToSseTransformStream` writes the payload and nothing else.
 * @param wire - The whole response body.
 * @returns One parsed chunk per frame, skipping the closing `[DONE]`.
 */
function frames(wire: string): Array<Record<string, unknown>> {
  return wire
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length).trim())
    .filter((body) => body !== "[DONE]")
    .map((body) => {
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        // A frame that will not parse is still a frame that arrived, and
        // saying so beats throwing here -- the assertion below reads better
        // than a parse error from inside a helper.
        return { type: `<未能解析: ${body}>` };
      }
    });
}

/**
 * The chunk types on a stream, in arrival order.
 * @param wire - The whole response body.
 * @returns One type per frame.
 */
function frameTypes(wire: string): string[] {
  return frames(wire).map((f) => (f.type as string | undefined) ?? "<无 type 字段>");
}

describe("a turn that has ended", () => {
  it("leaves no timer still beating", async () => {
    // Only the interval functions are faked, so the mock agent's own wait and
    // every promise in the request still run on real time. What is being
    // observed is one thing: whether the timer this stream started is still
    // registered once the stream is over.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const app = createApp();
      const res = await app.request(ENTRANCES[0]!.path, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(ENTRANCES[0]!.body),
      });
      await res.text();

      // One per finished stream is a timer that never stops, writing to a
      // socket nobody is reading and holding the process open behind it.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the first beat", () => {
  it("does not wait for the interval, because the client's clock is already running", async () => {
    // The reader's browser starts counting at the press, and everything
    // between that and the stream opening -- the network, authorising,
    // checking the conversation is writable -- makes no sound on its clock.
    // A first beat one whole interval after the socket opens spends that
    // budget on nothing, and a turn that is doing fine gets killed for it
    // with "network error" on screen.
    //
    // The intervals are frozen here on purpose: what has to arrive is a beat
    // that owes nothing to the timer.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const app = createApp();
      const res = await app.request(ENTRANCES[0]!.path, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(ENTRANCES[0]!.body),
      });

      const types = frameTypes(await res.text());
      expect(types[0]).toBe("data-heartbeat");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a beat", () => {
  it("is transient, so it never becomes part of the message", async () => {
    // Without this flag the beat is an ordinary data part: it lands in
    // `state.message.parts`, gets stored with the reply and renders in the
    // conversation. The SDK reads the flag at index.js:7416 and stops there,
    // handing the chunk to `onData` and nothing else. A beat carries no
    // meaning of its own -- its arrival is the whole message -- so anything
    // that keeps it around is keeping rubbish.
    const app = createApp();
    const res = await app.request(ENTRANCES[0]!.path, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(ENTRANCES[0]!.body),
    });

    const beats = frames(await res.text()).filter((f) => f.type === "data-heartbeat");
    expect(beats.length).toBeGreaterThan(0);
    for (const beat of beats) expect(beat.transient).toBe(true);
  });
});

describe("a turn that takes its time", () => {
  for (const entrance of ENTRANCES) {
    it(`keeps saying the stream is alive, from ${entrance.name}`, async () => {
      const app = createApp();
      const res = await app.request(entrance.path, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(entrance.body),
      });
      expect(res.status).toBe(200);

      const types = frameTypes(await res.text());

      // The client is watching for three missed intervals, so the stream has
      // to produce more than three over a silence this long or the rule it is
      // watching by would fire on a turn that is doing fine.
      expect(types.filter((t) => t === "data-heartbeat").length).toBeGreaterThanOrEqual(3);

      // And they have to come while nothing else is happening. Frames that
      // only appear alongside the reply prove nothing: the reply already
      // proves the stream is alive.
      expect(types[0]).toBe("data-heartbeat");
    });
  }
});
