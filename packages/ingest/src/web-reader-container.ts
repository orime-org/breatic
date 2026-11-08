// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The page reader (inner#1664): one instance per `web_fetch` call, a headless
 * browser inside, every request it makes answered by `webReaderOutbound`.
 *
 * The object owns its instance's life: a destroy is scheduled past the call's
 * deadline before anything starts, the read ends in a destroy whichever way it
 * goes, and `stop` ends it early when the caller has gone. The read's own
 * wrap-up is the one place a read destroys.
 */
import { Container } from "@cloudflare/containers";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { READER_SERVICE_PORT, readerServiceAnswerSchema } from "@breatic/shared";
import type { ReadPagesAnswer, ReadPagesRequest } from "@breatic/shared";

import { noteFailure } from "@ingest/error-monitoring.js";
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

  /** Settles once the read in progress has wrapped up, its destroy included. */
  private reading: Promise<void> | undefined;

  /** Whether the instance has been destroyed, so it is destroyed once. */
  private destroyed = false;

  /**
   * Read the pages, then destroy the instance.
   *
   * The destroy waits for the start to have an outcome: a destroy sent while
   * the start is on its way leaves the start to finish after it, with a
   * container running and nobody left to destroy it.
   * @param request - The pages and the limits to read them within.
   * @returns What each page produced, and what the container used.
   * @throws {Error} When the container would not start (the message starts
   *   `reader_not_started`), failed, answered something other than its answer,
   *   or the read was ended by `stop` or `expireRead`.
   */
  async read(request: ReadPagesRequest): Promise<ReadPagesAnswer> {
    const ended = new Promise<never>((_, reject) => {
      this.endRead = reject;
    });
    // Ended before anything raced it, it must not surface as unhandled.
    ended.catch(() => undefined);
    let wrappedUp: () => void = () => undefined;
    this.reading = new Promise<void>((resolve) => {
      wrappedUp = resolve;
    });
    let starting: Promise<void> | undefined;
    try {
      // A stop while the destroy is being scheduled ends the read here, before any start.
      await Promise.race([this.schedule(new Date(request.deadlineAt + DESTROY_MARGIN_MS), "expireRead", {}), ended]);
      const startedAt = Date.now();
      // Waits until the service listens on `defaultPort`, so the read is not sent to a closed port.
      starting = this.startAndWaitForPorts();
      await Promise.race([
        starting.catch((err: unknown) => {
          // Workers RPC carries the message across, not the class: the route reads this prefix.
          throw new Error(`reader_not_started: ${err instanceof Error ? err.message : String(err)}`);
        }),
        ended,
      ]);
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
      if (!answered.ok) {
        // The service's own words, bounded, so on-call can read why.
        const said = (await Promise.race([answered.text(), ended])).slice(0, 500);
        throw new Error(`the page reader answered ${String(answered.status)}: ${said}`);
      }
      const body = readerServiceAnswerSchema.parse(await Promise.race([answered.json(), ended]));
      return { pages: body.pages, usage: { wallMs: Date.now() - startedAt, cpuUsec: body.cpuUsec } };
    } finally {
      this.endRead = undefined;
      await starting?.catch(() => undefined);
      await this.destroyOnce();
      this.reading = undefined;
      wrappedUp();
    }
  }

  /**
   * End the read and wait for it to wrap up: the caller has gone. With no
   * read in progress, destroy the instance outright.
   * @returns Nothing.
   */
  async stop(): Promise<void> {
    await this.endAndWrapUp(new Error("the caller stopped the read"));
  }

  /**
   * The scheduled destroy, past the call's deadline.
   * @returns Nothing.
   */
  async expireRead(): Promise<void> {
    await this.endAndWrapUp(new Error("the read ran past its deadline"));
  }

  /**
   * End the read in progress and wait for its own wrap-up to destroy the
   * instance; with none in progress, destroy it here.
   * @param reason - What the read rejects with.
   * @returns Nothing.
   */
  private async endAndWrapUp(reason: Error): Promise<void> {
    const reading = this.reading;
    if (reading === undefined) {
      await this.destroyOnce();
      return;
    }
    this.endRead?.(reason);
    await reading;
  }

  /**
   * Destroy the instance, the first time this is asked.
   * @returns Nothing.
   */
  private async destroyOnce(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    // A failed destroy leaves a container running until its own timeout.
    await this.destroy().catch((err: unknown) => noteFailure("ingest_web_reader_destroy_failed", {}, err));
  }
}

// Assigned, as the mini-tool classes assign theirs: `outbound` is a static
// setter on `Container` that registers the handler for the class, and a class
// field would define a property beside it and register nothing.
WebReaderContainer.outbound = (request: Request, _env: unknown, _ctx: OutboundHandlerContext): Promise<Response> =>
  webReaderOutbound(request);
