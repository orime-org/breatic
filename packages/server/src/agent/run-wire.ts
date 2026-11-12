// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The frames one run writes to its resumable stream (inner#1717).
 *
 * A run is no longer tied to the request that started it, so nothing but
 * this wrapper owns the wire around the turn: the beats that say the run is
 * alive (stored with the stream, so a page that attaches late replays them),
 * the turn's own frames as they come, and the end. The end is held until the
 * run is settled: the panel stops reading at an error frame, and the
 * conversation may go straight on to another run, which the page has to hear
 * about first, so `data-next-run` is always the last frame before the turn's
 * `finish` or its error. Whatever throws, here or in the turn, is logged once
 * and ends the stream normally: a stream that errors would leave every
 * attached page with nothing to say.
 */
import type { UIMessageChunk } from "ai";
import { getAgentConfig, logger } from "@breatic/core";

/** What a run's wire needs. */
export interface RunWireOptions {
  /** The run, for the logs. */
  runId: string;
  /** Who and where, for the logs. */
  ctx: { userId: string; conversationId: string; projectId: string };
  /** Starts the turn: its chunks, in the SDK's protocol. */
  turn: () => Promise<ReadableStream<UIMessageChunk>>;
  /**
   * Called once the turn's chunks are all read, or it threw: settles the run
   * and, when the conversation goes on, opens the next run.
   * @returns The next run's id once its opening stage is done, or null.
   */
  afterTurn: (outcome: { threw: boolean }) => Promise<string | null>;
}

/**
 * One chunk, as the protocol puts it on the wire.
 * @param chunk - What to send.
 * @returns The frame.
 */
export function frame(chunk: UIMessageChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** The beat: transient, so the SDK hands it to `onData` and keeps nothing. */
const BEAT = frame({ type: "data-heartbeat", transient: true, data: {} });

/**
 * The run's frames, as one stream of SSE text.
 * @param options - The run.
 * @returns The stream; it always ends normally.
 */
export function runWire(options: RunWireOptions): ReadableStream<string> {
  const { runId, ctx } = options;
  let beat: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<string>({
    async start(controller) {
      /**
       * Write one frame, unless the stream has nowhere to go.
       * @param text - The frame.
       */
      const write = (text: string): void => {
        try {
          controller.enqueue(text);
        } catch {
          // The stream was cancelled; the run goes on without a reader.
        }
      };
      write(BEAT);
      beat = setInterval(() => write(BEAT), getAgentConfig().sse_heartbeat_interval_ms);
      let held: UIMessageChunk | undefined;
      let finish: UIMessageChunk | undefined;
      let threw = false;
      try {
        const reader = (await options.turn()).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.type === "error") {
            held ??= value;
            continue;
          }
          if (value.type === "finish") {
            finish = value;
            continue;
          }
          write(frame(value));
        }
      } catch (err) {
        threw = true;
        logger.error({ err, ...ctx, runId }, "chat_turn_failed");
      }
      let next: string | null = null;
      try {
        next = await options.afterTurn({ threw });
      } catch (err) {
        if (!threw) logger.error({ err, ...ctx, runId }, "chat_run_settle_failed");
        held ??= { type: "error", errorText: "The turn could not be run." };
      }
      if (threw) {
        write(frame({ type: "data-failed", data: {} }));
        held ??= { type: "error", errorText: "The turn could not be run." };
      }
      if (next !== null) write(frame({ type: "data-next-run", transient: true, data: { runId: next } }));
      if (held !== undefined) write(frame(held));
      else if (finish !== undefined) write(frame(finish));
      clearInterval(beat);
      try {
        controller.close();
      } catch {
        // Already cancelled.
      }
    },
    cancel() {
      // A cancelled reader does not stop the run; only its beat had nowhere to go.
    },
  });
}
