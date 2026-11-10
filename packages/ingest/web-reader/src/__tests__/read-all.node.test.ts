// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadPageResult } from "@breatic/shared";

import { readAll } from "../read-all.js";

/** What a page that read fine gives back. */
function okPage(url: string): ReadPageResult {
  return { url, status: "ok", kind: "html", title: `Title of ${url}`, text: `Text of ${url}` };
}

/** A page reader that never answers until its signal fires, then rejects. */
function hangUntilAborted(_url: string, signal: AbortSignal): Promise<ReadPageResult> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

/** Distinct urls, one per page. */
function urlsOf(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `https://site${i}.example/page`);
}

describe("readAll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps exactly min(concurrency, pages) reads in flight and answers in the order of urls", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 20 }),
        async (concurrency, delays) => {
          const urls = urlsOf(delays.length);
          let inFlight = 0;
          let maxInFlight = 0;
          const readOne = async (url: string): Promise<ReadPageResult> => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, delays[urls.indexOf(url)]));
            inFlight -= 1;
            return okPage(url);
          };

          const answer = readAll(urls, { concurrency, deadlineAt: Date.now() + 600_000, readOne });
          await vi.advanceTimersByTimeAsync(delays.reduce((sum, delay) => sum + delay, 0) + 1);

          await expect(answer).resolves.toEqual(urls.map(okPage));
          expect(maxInFlight).toBe(Math.min(concurrency, urls.length));
          expect(inFlight).toBe(0);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("answers in the order of urls when the last page finishes first", async () => {
    const urls = urlsOf(3);
    const delays = new Map([
      [urls[0], 300],
      [urls[1], 200],
      [urls[2], 100],
    ]);
    const finished: string[] = [];
    const readOne = async (url: string): Promise<ReadPageResult> => {
      await new Promise((resolve) => setTimeout(resolve, delays.get(url)));
      finished.push(url);
      return okPage(url);
    };

    const answer = readAll(urls, { concurrency: 3, deadlineAt: Date.now() + 600_000, readOne });
    await vi.advanceTimersByTimeAsync(301);

    await expect(answer).resolves.toEqual([okPage(urls[0] ?? ""), okPage(urls[1] ?? ""), okPage(urls[2] ?? "")]);
    expect(finished).toEqual([urls[2], urls[1], urls[0]]);
  });

  // Plan §14 row 11: a renderer that crashed ran out of memory on the page,
  // which is a page too large to read, not one that cannot be reached.
  it.each(["page.goto: Page crashed", "Target crashed", "page.evaluate: Target crashed"])(
    "records a page whose reader threw %j as too_large",
    async (message) => {
      const urls = ["https://a.example/", "https://huge.example/"];
      const readOne = async (url: string): Promise<ReadPageResult> => {
        if (url === "https://huge.example/") throw new Error(message);
        return okPage(url);
      };

      const answer = readAll(urls, { concurrency: 2, deadlineAt: Date.now() + 600_000, readOne });
      await vi.advanceTimersByTimeAsync(1);

      await expect(answer).resolves.toEqual([okPage("https://a.example/"), { url: "https://huge.example/", status: "too_large" }]);
    },
  );

  it("records a page whose reader throws as unreachable and leaves the others alone", async () => {
    const urls = ["https://a.example/", "https://b.example/", "https://c.example/"];
    const readOne = async (url: string): Promise<ReadPageResult> => {
      if (url === "https://b.example/") throw new Error("net::ERR_NAME_NOT_RESOLVED");
      return okPage(url);
    };

    const answer = readAll(urls, { concurrency: 2, deadlineAt: Date.now() + 600_000, readOne });
    await vi.advanceTimersByTimeAsync(1);

    await expect(answer).resolves.toEqual([
      okPage("https://a.example/"),
      { url: "https://b.example/", status: "unreachable" },
      okPage("https://c.example/"),
    ]);
  });

  it("stops every unfinished read 5 s before the deadline, records it too_slow and keeps what finished", async () => {
    const deadlineAt = Date.now() + 30_000;
    const urls = ["https://fast.example/", "https://ignores-abort.example/", "https://honours-abort.example/"];
    const signals = new Map<string, AbortSignal>();
    const readOne = (url: string, signal: AbortSignal): Promise<ReadPageResult> => {
      signals.set(url, signal);
      if (url === "https://fast.example/") {
        return new Promise((resolve) => setTimeout(() => resolve(okPage(url)), 1_000));
      }
      // A page that never settles, even once told to stop: readAll must not wait on it.
      if (url === "https://ignores-abort.example/") return new Promise(() => undefined);
      return hangUntilAborted(url, signal);
    };
    let outcome = "pending";

    const answer = readAll(urls, { concurrency: 3, deadlineAt, readOne });
    answer.then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = `rejected: ${error instanceof Error ? error.message : String(error)}`;
      },
    );

    await vi.advanceTimersByTimeAsync(24_999);
    expect(outcome).toBe("pending");
    expect(signals.get("https://ignores-abort.example/")?.aborted).toBe(false);
    expect(signals.get("https://honours-abort.example/")?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toEqual([
      okPage("https://fast.example/"),
      { url: "https://ignores-abort.example/", status: "too_slow" },
      { url: "https://honours-abort.example/", status: "too_slow" },
    ]);
    expect(signals.get("https://ignores-abort.example/")?.aborted).toBe(true);
    expect(signals.get("https://honours-abort.example/")?.aborted).toBe(true);
  });

  it("never starts a page still queued at the deadline and records it too_slow", async () => {
    const deadlineAt = Date.now() + 30_000;
    const urls = ["https://stuck.example/", "https://queued.example/"];
    const started: string[] = [];
    const readOne = (url: string, signal: AbortSignal): Promise<ReadPageResult> => {
      started.push(url);
      return hangUntilAborted(url, signal);
    };

    const answer = readAll(urls, { concurrency: 1, deadlineAt, readOne });
    await vi.advanceTimersByTimeAsync(25_000);

    await expect(answer).resolves.toEqual([
      { url: "https://stuck.example/", status: "too_slow" },
      { url: "https://queued.example/", status: "too_slow" },
    ]);
    expect(started).toEqual(["https://stuck.example/"]);
  });

  // Plan §9 row O: one slow page must not hold its slot until the whole
  // call's stop time. Each page's signal fires at whichever comes first, the
  // call's stop or its own `pageTimeoutMs`, and a page stopped by its own
  // timeout is recorded too_slow while the others read on.
  it("stops a page at pageTimeoutMs, records it too_slow and reads the rest", async () => {
    const urls = ["https://slow.example/", "https://queued.example/", "https://fast.example/"];
    const signals = new Map<string, AbortSignal>();
    const readOne = (url: string, signal: AbortSignal): Promise<ReadPageResult> => {
      signals.set(url, signal);
      if (url === "https://slow.example/") return hangUntilAborted(url, signal);
      return new Promise((resolve) => setTimeout(() => resolve(okPage(url)), 100));
    };

    const answer = readAll(urls, { concurrency: 2, deadlineAt: Date.now() + 600_000, pageTimeoutMs: 1_000, readOne });
    await vi.advanceTimersByTimeAsync(999);
    expect(signals.get("https://slow.example/")?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signals.get("https://slow.example/")?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(101);

    await expect(answer).resolves.toEqual([
      { url: "https://slow.example/", status: "too_slow" },
      okPage("https://queued.example/"),
      okPage("https://fast.example/"),
    ]);
    // The page timeout belongs to the slow page alone.
    expect(signals.get("https://queued.example/")?.aborted).toBe(false);
    expect(signals.get("https://fast.example/")?.aborted).toBe(false);
  });

  it("frees the slot of a timed-out page so a queued page is read with one slot", async () => {
    const urls = ["https://slow.example/", "https://next.example/"];
    const started: string[] = [];
    const readOne = (url: string, signal: AbortSignal): Promise<ReadPageResult> => {
      started.push(url);
      if (url === "https://slow.example/") return hangUntilAborted(url, signal);
      return Promise.resolve(okPage(url));
    };

    const answer = readAll(urls, { concurrency: 1, deadlineAt: Date.now() + 600_000, pageTimeoutMs: 1_000, readOne });
    await vi.advanceTimersByTimeAsync(1_001);

    expect(started).toEqual(["https://slow.example/", "https://next.example/"]);
    await expect(answer).resolves.toEqual([{ url: "https://slow.example/", status: "too_slow" }, okPage("https://next.example/")]);
  });

  it("gives each page its own pageTimeoutMs, counted from when it starts", async () => {
    const urls = ["https://first.example/", "https://second.example/"];
    const signals = new Map<string, AbortSignal>();
    const readOne = (url: string, signal: AbortSignal): Promise<ReadPageResult> => {
      signals.set(url, signal);
      // Each page takes 800 ms: under its own 1 000 ms, though the second
      // finishes 1 600 ms after the call began.
      return new Promise((resolve) => setTimeout(() => resolve(okPage(url)), 800));
    };

    const answer = readAll(urls, { concurrency: 1, deadlineAt: Date.now() + 600_000, pageTimeoutMs: 1_000, readOne });
    await vi.advanceTimersByTimeAsync(1_601);

    await expect(answer).resolves.toEqual([okPage("https://first.example/"), okPage("https://second.example/")]);
    expect(signals.get("https://second.example/")?.aborted).toBe(false);
  });

  it("still stops every page at the call's stop time when that comes before pageTimeoutMs", async () => {
    const deadlineAt = Date.now() + 10_000;
    const urls = ["https://stuck.example/"];
    const readOne = (url: string, signal: AbortSignal): Promise<ReadPageResult> => hangUntilAborted(url, signal);

    const answer = readAll(urls, { concurrency: 1, deadlineAt, pageTimeoutMs: 30_000, readOne });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(answer).resolves.toEqual([{ url: "https://stuck.example/", status: "too_slow" }]);
  });
});

