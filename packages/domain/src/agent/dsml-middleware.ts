// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * DSML markup taken out of a model's reply text as it streams, so it never
 * reaches the reader, the stored message or the next turn's prompt. What
 * counts as markup is `stripDsml` in `@breatic/shared`.
 *
 * Only text deltas are touched. Tool calls, `raw` parts and the rest pass
 * through as they came: the provider sends a `raw` part before each parsed
 * part and its tool calls while the text is still open, so none of them say
 * anything about where the markup ends. A call block closes the model's
 * message, so once one starts, the rest of that step's text is dropped.
 */

import type { LanguageModelMiddleware } from "ai";
import { dsmlBlockStart, dsmlHeldFrom, stripDsml } from "@breatic/shared";

/** What one model step streams. */
type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;

/** One part of that stream. */
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/**
 * The transform for one step's stream.
 *
 * A tail that could still turn into a tag is held until the next delta
 * shows what it is, and let go at `text-end` or `finish` if nothing came.
 * @returns A stream transform that leaves everything but the markup as it was.
 */
function withoutDsml(): TransformStream<StreamPart, StreamPart> {
  let held = "";
  let heldId = "";
  let inBlock = false;

  return new TransformStream({
    transform(part, controller) {
      if (part.type === "text-delta") {
        if (inBlock) return;
        const text = held + part.delta;
        const block = dsmlBlockStart(text);
        const end = block === -1 ? dsmlHeldFrom(text) : block;
        const passed = stripDsml(text.slice(0, end));
        held = block === -1 ? text.slice(end) : "";
        heldId = part.id;
        inBlock = block !== -1;
        if (passed) controller.enqueue({ ...part, delta: passed });
        return;
      }
      if ((part.type === "text-end" || part.type === "finish") && held) {
        const rest = stripDsml(held);
        held = "";
        if (rest) controller.enqueue({ type: "text-delta", id: heldId, delta: rest });
      }
      controller.enqueue(part);
    },
  });
}

/** Takes DSML markup out of every step's streamed reply text. */
export const dsmlMiddleware: LanguageModelMiddleware = {
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    return { ...rest, stream: stream.pipeThrough(withoutDsml()) };
  },
};
