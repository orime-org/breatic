// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Reading one call's pages a few at a time, within its deadline (inner#1664). */
import type { ReadPageResult } from "@breatic/shared";

/**
 * How long before the call's deadline reading stops, so the answer and the
 * container's usage still reach the server in time.
 */
const STOP_BEFORE_DEADLINE_MS = 5_000;

/** How `readAll` reads. */
export interface ReadAllOptions {
  /** The most pages read at once. */
  concurrency: number;
  /** When the call's answer is due, epoch ms; reading stops 5 s before it. */
  deadlineAt: number;
  /** How long one page may take from its start; past it the page is `too_slow`. */
  pageTimeoutMs?: number;
  /** Read one page; the signal fires when the page must stop. */
  readOne: (url: string, signal: AbortSignal) => Promise<ReadPageResult>;
}

/**
 * Read every page, at most `concurrency` at once.
 *
 * At the stop time every unfinished page is told to stop and recorded
 * `too_slow`, and the answer goes back at once: a page that ignores the stop
 * does not hold up the pages that were read. A page past its own
 * `pageTimeoutMs` is stopped the same way and recorded `too_slow`, and its
 * slot goes to the next page.
 * @param urls - The pages, in the caller's order.
 * @param options - Concurrency, deadline and the reader of one page.
 * @returns One result per url, in the order of `urls`.
 * @throws {never} Never; a page whose reader throws is recorded `unreachable`.
 */
export async function readAll(urls: string[], options: ReadAllOptions): Promise<ReadPageResult[]> {
  const { concurrency, deadlineAt, pageTimeoutMs, readOne } = options;
  const results: Array<ReadPageResult | undefined> = urls.map(() => undefined);
  const stop = new AbortController();
  const stopped = new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
  let next = 0;

  const worker = async (): Promise<void> => {
    while (!stop.signal.aborted && next < urls.length) {
      const i = next;
      next += 1;
      const url = urls[i] as string;
      // The page stops at the call's stop or its own timeout, whichever is first.
      const pageStop = new AbortController();
      /** Stop the page when the call stops. */
      const onStop = (): void => pageStop.abort();
      stop.signal.addEventListener("abort", onStop, { once: true });
      let pageTimer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<ReadPageResult>((resolve) => {
        if (pageTimeoutMs === undefined) return;
        pageTimer = setTimeout(() => {
          pageStop.abort();
          resolve({ url, status: "too_slow" });
        }, pageTimeoutMs);
      });
      try {
        results[i] = await Promise.race([readOne(url, pageStop.signal), timedOut]);
      } catch {
        if (!stop.signal.aborted) results[i] = { url, status: pageStop.signal.aborted ? "too_slow" : "unreachable" };
      } finally {
        clearTimeout(pageTimer);
        stop.signal.removeEventListener("abort", onStop);
      }
    }
  };

  const timer = setTimeout(() => stop.abort(), Math.max(0, deadlineAt - STOP_BEFORE_DEADLINE_MS - Date.now()));
  try {
    const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
    await Promise.race([Promise.all(workers), stopped]);
  } finally {
    clearTimeout(timer);
  }
  return urls.map((url, i) => results[i] ?? { url, status: "too_slow" });
}
