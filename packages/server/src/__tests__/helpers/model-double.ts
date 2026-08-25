// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A model that says what a test tells it to.
 *
 * Cases about what a turn does with the model's output put the double here,
 * at the model, rather than at `streamTextRetry`. That call is where the
 * SDK turns provider parts into the protocol the client reads -- replacing it
 * would mean the test hands over the very shapes it then checks, and would
 * pass just as well against a turn that had stopped forwarding anything.
 *
 * With the model as the double, `streamText` runs for real: it calls the
 * tools the turn registered, honours the stop signal, and assembles the
 * message the turn stores.
 */
import { MockLanguageModelV4 } from "ai/test";

/** The stream a model call hands back. */
type ModelStream = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"];

/**
 * One piece of a model's output, as the provider layer states it.
 *
 * Read off the model's own signature rather than imported: the type lives in
 * `@ai-sdk/provider`, which reaches us only through `ai`, and naming a
 * package we do not depend on would make these files fail for a reason that
 * has nothing to do with what they check.
 */
export type ModelStreamPart = ModelStream extends ReadableStream<infer Part> ? Part : never;

/** The end of one step, as the provider layer states it. */
type FinishPart = Extract<ModelStreamPart, { type: "finish" }>;

/**
 * One step's ending.
 *
 * Both fields the provider layer states here are shaped differently from
 * their counterparts one layer in, and writing either as the flatter shape
 * type-checks nowhere but reads as though it should: the finish reason is an
 * object carrying the provider's own wording alongside the unified one, and
 * the usage is nested with no total of its own -- the flat `totalTokens` the
 * turn adds up is what the SDK works out from this.
 * @param unified - Why the step ended, in the SDK's own vocabulary.
 * @param outputTotal - Output tokens the step spent.
 * @returns The finish part.
 */
function finishing(
  unified: FinishPart["finishReason"]["unified"],
  outputTotal: number,
): ModelStreamPart {
  return {
    type: "finish",
    finishReason: { unified, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: outputTotal, text: outputTotal, reasoning: 0 },
    },
  };
}

/** One step's worth of ending, which `streamText` waits for. */
export const FINISHED: ModelStreamPart = finishing("stop", 1);

/** The same, for a step that ends by asking for a tool. */
export const FINISHED_ASKING_FOR_A_TOOL: ModelStreamPart = finishing("tool-calls", 1);

/**
 * A step that ended normally, having spent a stated number of output tokens.
 * @param outputTotal - What to report for the step.
 * @returns The finish part.
 */
export function finishedSpending(outputTotal: number): ModelStreamPart {
  return finishing("stop", outputTotal);
}

/**
 * A model that produces whatever the caller is holding when it is called.
 *
 * Takes a function rather than a list because the model is built once, inside
 * a module mock, and each case changes what it should say.
 * @param parts - Consulted at call time for this turn's output.
 * @param onCalled - Handed what the model was asked, for cases about what a
 *   turn puts in front of it rather than about what it says back.
 * @param afterDrained - Run once the SDK has taken every part, before the
 *   stream closes, and handed the controller so it can put more on. This is
 *   how a case reaches an exact moment inside a turn: the SDK queues tool
 *   calls as they arrive and only runs the queue when the model call ends, so
 *   a stop timed from outside lands wherever it lands. Holding the last part
 *   back and enqueuing it from here puts the stop between two named chunks.
 * @returns A model the turn can be run against.
 */
export function modelProducing(
  parts: () => ModelStreamPart[],
  onCalled?: (asked: { prompt: unknown }) => void,
  afterDrained?: (controller: ReadableStreamDefaultController<ModelStreamPart>) => void,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (asked) => {
      onCalled?.(asked);
      return {
        stream: new ReadableStream<ModelStreamPart>({
          start(controller) {
            for (const part of parts()) controller.enqueue(part);
            if (afterDrained === undefined) controller.close();
          },
          pull(controller) {
            afterDrained?.(controller);
            controller.close();
          },
        }),
      };
    },
  });
}

/**
 * A model whose call never produces a stream at all.
 *
 * Different from a stream carrying an `error` part: this one fails before
 * there is a stream, which is what an invalid request looks like -- the SDK
 * validates what it is about to send and throws at the door. Nothing of the
 * turn has reached the client at that point, so what the client is told is
 * entirely down to how the failure is handled.
 * @param why - What the call fails with.
 * @returns A model the turn can be run against.
 */
export function modelFailingToStart(why: Error): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: () => Promise.reject(why),
  });
}

/** One turn of plain prose, start to end. */
export const saying = (text: string): ModelStreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  FINISHED,
];
