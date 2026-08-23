// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * However a turn is put together, it settles up once.
 *
 * The example-based tests next door each pin one shape of turn. What they
 * cannot cover is the shape nobody thought of, and the arrangement here has
 * the classic defect built into it: the turn's wrap-up is attached to two
 * ends of the same stream. The SDK calls it from `flush` when the stream runs
 * out and from `cancel` when the reader lets go, and only a flag inside it
 * keeps those from both landing. If that flag ever stopped holding, the
 * second stored reply and the second charge would arrive together and both
 * would look exactly like the first.
 *
 * So the model's output is generated rather than written: arbitrary runs of
 * prose, tool calls and failures, in arbitrary order and number, including
 * none at all -- each read to the end and again with the reader walking away
 * part way through.
 *
 * The count of stored replies is stated as an equality rather than as "at
 * most one", because how many a turn owes follows from rules that hold for
 * any stream: one if it produced anything or failed, none otherwise. `≤ 1`
 * would be satisfied by a turn that stored nothing at all, which is the very
 * defect the failed-turn path exists to prevent.
 *
 * A turn the user stopped is not generated here. Stopping is driven by a
 * signal rather than by anything the model says, so it has no counterpart
 * among the parts a model produces; `turn-cleanup-on-abort.test.ts` and
 * `turn-exit-paths.test.ts` cover it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";
import { FINISHED } from "../helpers/model-double.js";
import type { ModelStreamPart } from "../helpers/model-double.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>) => 1);
const consolidateIfNeeded = vi.fn(async () => undefined);
const chargeOnceForGeneration = vi.fn(async (..._args: unknown[]) => null);

/** What the model produces this run. */
const modelSays = vi.hoisted(() => ({ parts: [] as unknown[] }));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { userMemory: "", projectMemory: "", conversationMemory: "" },
    compressedHistory: [],
  })),
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

// The finalizer is the real one: what it does with its two entrances is the
// whole subject here, and a double for it would be this file deciding the
// answer it then checks.
vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await vi.importActual<typeof DomainModule>("@breatic/domain");
  const { modelProducing } = await import("../helpers/model-double.js");
  return {
    ...base,
    finalizeTurn: actual.finalizeTurn,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({ modelId: "m", instructions: "s", tools: {} }),
    creditLotService: { chargeOnceForGeneration },
    resolveProvider: () => "test",
    getModel: () => modelProducing(() => modelSays.parts as ModelStreamPart[]),
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

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  getMessages,
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  titleForTurn: vi.fn(async () => null),
}));

vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateIfNeeded }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

/** One thing a model can do, as the parts that do it. */
type Unit = { kind: "prose" | "tool" | "failure"; parts: ModelStreamPart[] };

/**
 * The three things a model does, each as a run of parts that is valid on its
 * own -- prose has to be opened and closed around its pieces, so the unit and
 * not the piece is what gets shuffled.
 */
const unitArbitrary = fc.oneof(
  fc.string({ minLength: 1, maxLength: 4 }).map(
    (text): Unit => ({
      kind: "prose",
      parts: [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
      ],
    }),
  ),
  fc.constant<Unit>({
    kind: "tool",
    parts: [
      {
        type: "tool-call",
        toolCallId: "tc",
        toolName: "web_search",
        input: JSON.stringify({}),
      },
    ],
  }),
  fc.constant<Unit>({
    kind: "failure",
    parts: [{ type: "error", error: new Error("provider said no") }],
  }),
);

/**
 * What the rules say this turn owes, worked out independently of the code.
 *
 * A stored reply is owed when there is anything to say about the turn: prose
 * it wrote, a tool it called, or the mark a failure leaves. A turn that
 * produced none of those has nothing to record, and storing an empty message
 * for it would put a blank reply in the reader's conversation.
 *
 * Deriving the expectation rather than reading it off the run is what makes
 * the assertion a check instead of a restatement.
 * @param units - What the model did.
 * @returns How many stored replies the turn owes.
 */
function storedRepliesOwed(units: readonly Unit[]): number {
  return units.length > 0 ? 1 : 0;
}

/**
 * Run one turn over the given model output.
 * @param units - What the model does, in order.
 * @param letGoAfter - Read this many chunks and then walk away; read to the
 *   end when absent.
 * @returns What was stored and what was charged.
 */
async function settle(
  units: readonly Unit[],
  letGoAfter?: number,
): Promise<{ storedReplies: number; charges: number }> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = await import("@breatic/core");
  modelSays.parts = [...units.flatMap((u) => u.parts), FINISHED];

  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const reader = (await new MainAgent().chat("hi")).getReader();
    let read = 0;
    for (;;) {
      if (letGoAfter !== undefined && read >= letGoAfter) {
        await reader.cancel();
        break;
      }
      const { done } = await reader.read();
      if (done) break;
      read += 1;
    }
  });

  const storedReplies = addMessage.mock.calls
    .map(([, msg]) => msg)
    .filter((msg) => msg.role === "assistant").length;
  return { storedReplies, charges: chargeOnceForGeneration.mock.calls.length };
}

beforeEach(() => {
  [addMessage, consolidateIfNeeded, chargeOnceForGeneration].forEach((m) => {
    m.mockClear();
  });
});

describe("whatever the model says, the turn settles up once", () => {
  it("stores what it owes and charges at most once, read to the end", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(unitArbitrary, { maxLength: 8 }), async (units) => {
        [addMessage, chargeOnceForGeneration].forEach((m) => {
          m.mockClear();
        });
        const { storedReplies, charges } = await settle(units);
        expect(storedReplies).toBe(storedRepliesOwed(units));
        // At most one, not exactly one: a turn where no step finished spent
        // nothing and owes nothing. What must never happen is two.
        expect(charges).toBeLessThanOrEqual(1);
      }),
      { numRuns: 120 },
    );
  }, 60_000);

  it("settles once when the reader walks away part way through", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(unitArbitrary, { maxLength: 8 }),
        fc.nat({ max: 10 }),
        async (units, letGoAfter) => {
          [addMessage, chargeOnceForGeneration].forEach((m) => {
            m.mockClear();
          });
          const { storedReplies, charges } = await settle(units, letGoAfter);
          // Not an equality here: what a turn has produced by the time the
          // reader lets go depends on where in the stream that lands, and a
          // rule derived from the parts alone could not say. What it can say
          // is that letting go never doubles anything -- which is the defect
          // two entrances to one wrap-up would produce.
          expect(storedReplies).toBeLessThanOrEqual(1);
          expect(charges).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 120 },
    );
  }, 60_000);
});
