// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
 * most one", because how many a turn owes follows from a rule that holds for
 * any stream: exactly one. `≤ 1` would be satisfied by a turn that stored
 * nothing at all, which is the very defect the failed-turn path exists to
 * prevent.
 *
 * The charge is stated the same way: exactly one when the turn recorded any
 * usage, and none when it recorded nothing. `≤ 1` would also pass a turn that
 * used credits and charged for none, which is the loss inner#1617 closes.
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
const foldIfTooLong = vi.fn(async () => "none");
const chargeOnce = vi.fn(async (..._args: unknown[]) => null);

/** What the model produces this run. */
const modelSays = vi.hoisted(() => ({ parts: [] as unknown[] }));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { entries: [], migrated: [], olderCount: 0, progress: "" },
    history: [],
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
    buildAgentConfig: () => ({ modelId: "m", instructions: { base: "s" }, tools: {} }),
    creditLotService: { chargeOnce },
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
  addUserMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsks: [] }),
  getMessages,
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  getMessagesForLlm: async () => [],
  titleForTurn: vi.fn(async () => null),
}));

vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong }));
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

/** What one turn left behind. */
interface Settled {
  storedReplies: number;
  /** The credits the turn's usage recorder holds once the turn is over. */
  recorded: number;
  /** Every call the turn made to `chargeOnce`. */
  charges: unknown[][];
}

/**
 * Run one turn over the given model output.
 * @param units - What the model does, in order.
 * @param letGoAfter - Read this many chunks and then walk away; read to the
 *   end when absent.
 * @returns What was stored, what was recorded and what was charged.
 */
async function settle(
  units: readonly Unit[],
  letGoAfter?: number,
): Promise<Settled> {
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
  const { createUsageRecorder } = await import("@breatic/domain");
  const recorder = vi.mocked(createUsageRecorder).mock.results.at(-1)?.value as
    | { settleForCharge: () => Promise<{ credits: number }> }
    | undefined;
  if (recorder === undefined) throw new Error("the turn opened no usage recorder");
  const { credits: recorded } = await recorder.settleForCharge();
  return { storedReplies, recorded, charges: chargeOnce.mock.calls };
}

/**
 * Check the turn charged exactly what it recorded, once, or nothing when it
 * recorded nothing.
 * @param settled - What the turn left behind.
 */
function expectChargedOnceForUsage(settled: Settled): void {
  if (settled.recorded > 0) {
    expect(settled.charges).toHaveLength(1);
    expect(settled.charges[0]?.[0]).toBe("operation");
    expect(settled.charges[0]?.[2]).toMatchObject({ amount: settled.recorded });
  } else {
    expect(settled.charges).toEqual([]);
  }
}

beforeEach(() => {
  [addMessage, foldIfTooLong, chargeOnce].forEach((m) => {
    m.mockClear();
  });
});

describe("whatever the model says, the turn settles up once", () => {
  it("stores what it owes and charges what it recorded exactly once, read to the end", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(unitArbitrary, { maxLength: 8 }), async (units) => {
        [addMessage, chargeOnce].forEach((m) => {
          m.mockClear();
        });
        const settled = await settle(units);
        expect(settled.storedReplies).toBe(1);
        // A turn where no step finished spent nothing and owes nothing; any
        // other turn owes exactly what it recorded, once.
        expectChargedOnceForUsage(settled);
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
          [addMessage, chargeOnce].forEach((m) => {
            m.mockClear();
          });
          const settled = await settle(units, letGoAfter);
          // Not an equality here: what a turn has produced by the time the
          // reader lets go depends on where in the stream that lands, and a
          // rule derived from the parts alone could not say. What it can say
          // is that letting go never doubles anything -- which is the defect
          // two entrances to one wrap-up would produce. The amount is not
          // compared with the recorder: this reader lets go without an abort
          // signal, so the model double can record usage after the bill step
          // read it. The product never takes that path -- both chat entries
          // pass the signal from `streamUntilClientLeaves` -- and the exact
          // amount is held by the read-to-the-end property above.
          expect(settled.storedReplies).toBeLessThanOrEqual(1);
          expect(settled.charges.length).toBeLessThanOrEqual(1);
          if (settled.charges.length === 1) {
            expect(settled.charges[0]?.[0]).toBe("operation");
            expect((settled.charges[0]?.[2] as { amount: number }).amount).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 120 },
    );
  }, 60_000);
});
