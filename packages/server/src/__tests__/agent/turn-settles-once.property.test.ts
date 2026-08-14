// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * However a turn is put together, it settles up once.
 *
 * The example-based tests next door each pin one shape of turn. What they
 * cannot cover is the shape nobody thought of, and this is a `finally` around
 * a loop with three `break`s in it — the arrangement whose classic defect is
 * running the wrap-up twice, once on the way out and once in the `finally`.
 * The second ending, the second stored reply and the second charge all arrive
 * together and all look like the first.
 *
 * So the stream is generated rather than written: arbitrary runs of deltas,
 * finished steps, tool results, failures and stops, in arbitrary order and
 * number, including the empty one.
 *
 * The invariant is stated as an equality rather than as "at most one",
 * because how many wrap-up messages a turn owes is decided by rules that hold
 * for any stream at all: one if it produced prose or was stopped, none
 * otherwise. `≤ 1` would be satisfied by a turn that stored nothing at all,
 * which is the very defect the stopped-turn path exists to prevent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);
const deductOnce = vi.fn(async (..._args: unknown[]) => undefined);
const streamTextRetry = vi.fn();

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(() => 40),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
  };
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await vi.importActual<typeof DomainModule>("@breatic/domain");
  return {
    ...base,
    finalizeTurn: actual.finalizeTurn,
    buildAgentConfig: () => ({ modelId: "m", instructions: "s", tools: {} }),
    streamTextRetry,
    creditService: { deductOnce },
    resolveProvider: () => "test",
    getModel: () => "model",
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});
/**
 * What the conversation holds, for the settle-up every turn opens with.
 *
 * Empty because these cases are about what happens after that: the point of
 * the event is that the browser takes the server's version, and a version
 * with nothing in it is the version that gets out of the way.
 */
const getMessages = vi.fn(async () => ({ messages: [], hasMore: false }));

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({ addMessage, getMessages }));
vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

/** One thing a stream can say. */
type Part = Record<string, unknown>;

/**
 * The six kinds of part a turn reacts to, in the shapes the SDK sends — seven
 * arbitraries, because a tool-result is drawn both plain and carrying the
 * sentinel that makes it a blocking interaction.
 */
const partArbitrary = fc.oneof(
  fc.string({ minLength: 1, maxLength: 4 }).map((text) => ({ type: "text-delta", text })),
  fc
    .integer({ min: 0, max: 900 })
    .map((totalTokens) => ({ type: "finish-step", usage: { totalTokens } })),
  fc.constant({ type: "tool-call", toolCallId: "t1", toolName: "web_search", input: {} }),
  fc.constant({ type: "tool-result", toolCallId: "t1", output: "{}" }),
  fc.constant({ type: "tool-result", toolCallId: "t1", output: "__ASK_USER__{}" }),
  fc.constant({ type: "error", error: new Error("provider said no") }),
  fc.constant({ type: "abort" }),
);

/**
 * What the rules say this stream owes, worked out independently of the code.
 *
 * A turn does not read to the end of its stream, so working this out means
 * working out where it stopped. There are three ways, and the third is the one
 * a hand-written expectation misses — the property found it on the seventeenth
 * try, with a stop that arrived after the turn had already left:
 *
 *   - a failure ends it there;
 *   - a stop ends it there, and a stopped turn is always stored, prose or not;
 *   - a tool that asks the user something ends it at the NEXT finished step,
 *     not at the tool's own result, because that step's tokens arrive after it
 *     and the turn owes the charge for them.
 *
 * Deriving the expectation rather than reading it off the run is what makes
 * the assertion a check instead of a restatement.
 * @param parts - The stream the turn was given.
 * @returns How many wrap-up messages the turn owes.
 */
function wrapUpsOwed(parts: readonly Part[]): number {
  // Anything the turn did is worth recording, not just what it said. A turn
  // that called a tool and never got a word out used to leave nothing behind;
  // now the call itself is part of the reply, so there is something to store.
  //
  // The two endings that did not finish — stopped and failed — are stored
  // whatever else happened, because each leaves a mark of its own saying so.
  // Without that a turn that failed on its first token would leave no trace,
  // and what the user said would sit alone with no answer and no reason.
  let didSomething = false;
  let askedTheUser = false;
  for (const part of parts) {
    if (part.type === "error") return 1;
    if (part.type === "abort") return 1;
    if (part.type === "finish-step" && askedTheUser) return didSomething ? 1 : 0;
    if (part.type === "text-delta") didSomething = true;
    if (part.type === "tool-call") didSomething = true;
    if (part.type === "tool-result" && String(part.output).startsWith("__ASK_USER__")) {
      askedTheUser = true;
    }
  }
  return didSomething ? 1 : 0;
}

/** A stream that plays the given parts and records nothing else. */
function streamOf(parts: readonly Part[]): Record<string, unknown> {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    get usage() {
      throw new Error("usage must never be read: it consumes the stream");
    },
  };
}

/**
 * Run one turn over the given stream and report what it settled.
 * @param parts - The stream to play.
 * @returns The endings emitted, the wrap-up messages written, and the charges.
 */
async function settle(
  parts: readonly Part[],
): Promise<{ endings: number; wrapUps: number; charges: number }> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  streamTextRetry.mockReturnValue(streamOf(parts));

  let endings = 0;
  await runWithContext(
    {
      userId: "u1",
      conversationId: "c1",
      memoryContext: { userMemory: "", projectMemory: "", conversationMemory: "" },
      compressedHistory: [],
    },
    async () => {
      for await (const event of new MainAgent().chat("hi")) {
        if ((event as { event: string }).event === "chat_done") endings += 1;
      }
    },
  );

  const wrapUps = addMessage.mock.calls
    .map(([, msg]) => msg)
    .filter((msg) => msg.role === "assistant" && msg.tool_calls === undefined).length;
  return { endings, wrapUps, charges: deductOnce.mock.calls.length };
}

beforeEach(() => {
  [addMessage, consolidateIfNeeded, deductOnce, streamTextRetry].forEach((m) => m.mockClear());
});

describe("whatever the stream says, the turn settles up once", () => {
  it("emits one ending, stores what it owes, and charges at most once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(partArbitrary, { maxLength: 12 }), async (parts) => {
        [addMessage, deductOnce].forEach((m) => m.mockClear());
        const { endings, wrapUps, charges } = await settle(parts);
        expect(endings).toBe(1);
        expect(wrapUps).toBe(wrapUpsOwed(parts));
        // At most one, not exactly one: a turn where no step finished consumed
        // nothing and owes nothing. What must never happen is two.
        expect(charges).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  }, 60_000);
});
