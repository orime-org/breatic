// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The page reader (inner#1664): one instance per `web_fetch` call, a headless
 * browser inside, every request it makes answered by `webReaderOutbound`.
 *
 * The object owns its instance's life: a destroy is scheduled past the call's
 * deadline before anything starts, the read ends in a destroy whichever way it
 * goes, and `stop` ends it early when the caller has gone.
 */
import { Container } from "@cloudflare/containers";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { READER_SERVICE_PORT, readerServiceAnswerSchema } from "@breatic/shared";
import type { ReadPagesAnswer, ReadPagesRequest } from "@breatic/shared";

import { webReaderOutbound } from "@ingest/web-reader-outbound.js";

/**
 * How long past the call's deadline the scheduled destroy fires. The reader
 * stops its own pages 5 s before the deadline, so by then the read has ended
 * or the container has hung.
 */
const DESTROY_MARGIN_MS = 30_000;

/** One call's page reader. */
export class WebReaderContainer extends Container {
  defaultPort = READER_SERVICE_PORT;

  /** No route out but the outbound handler. */
  enableInternet = false;

  /** Carries that to HTTPS as well. */
  interceptHttps = true;

  /** Ends the read in progress, when one is. */
  private endRead: ((reason: Error) => void) | undefined;

  /** Whether the instance has been destroyed, so it is destroyed once. */
  private destroyed = false;

  /**
   * Read the pages, then destroy the instance.
   * @param request - The pages and the limits to read them within.
   * @returns What each page produced, and what the container used.
   * @throws {Error} When the container would not start, failed, answered
   *   something other than its answer, or the caller stopped the read.
   */
  async read(request: ReadPagesRequest): Promise<ReadPagesAnswer> {
    await this.schedule(new Date(request.deadlineAt + DESTROY_MARGIN_MS), "expireRead", {});
    const ended = new Promise<never>((_, reject) => {
      this.endRead = reject;
    });
    const startedAt = Date.now();
    try {
      await Promise.race([this.start(), ended]);
      const answered = await Promise.race([
        this.containerFetch(
          new Request("http://reader/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          }),
        ),
        ended,
      ]);
      if (!answered.ok) throw new Error(`the page reader answered ${String(answered.status)}`);
      const body = readerServiceAnswerSchema.parse(await Promise.race([answered.json(), ended]));
      return { pages: body.pages, usage: { wallMs: Date.now() - startedAt, cpuUsec: body.cpuUsec } };
    } finally {
      this.endRead = undefined;
      await this.destroyOnce();
    }
  }

  /**
   * Stop reading and destroy the instance: the caller has gone.
   * @returns Nothing.
   */
  async stop(): Promise<void> {
    this.endRead?.(new Error("the caller stopped the read"));
    await this.destroyOnce();
  }

  /**
   * The scheduled destroy, past the call's deadline.
   * @returns Nothing.
   */
  async expireRead(): Promise<void> {
    this.endRead?.(new Error("the read ran past its deadline"));
    await this.destroyOnce();
  }

  /**
   * Destroy the instance, the first time this is asked.
   * @returns Nothing.
   */
  private async destroyOnce(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.destroy().catch(() => undefined);
  }
}

// Assigned, as the mini-tool classes assign theirs: `outbound` is a static
// setter on `Container` that registers the handler for the class, and a class
// field would define a property beside it and register nothing.
WebReaderContainer.outbound = (request: Request, _env: unknown, _ctx: OutboundHandlerContext): Promise<Response> =>
  webReaderOutbound(request);
