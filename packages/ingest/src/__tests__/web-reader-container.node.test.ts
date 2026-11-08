// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The page reader's lifecycle (inner#1664, design §6.2, §9 row 9): one
 * instance per call, a destroy scheduled past the call's deadline, the
 * container started and asked once, and the instance destroyed whether the
 * read succeeds or fails, with the wall time measured by the object.
 *
 * The `Container` base class needs a runtime with containers enabled, which
 * neither test pool has, so it is replaced here by a stand-in that records
 * what the subclass asks of it. What this leaves for the image smoke: that the
 * real base class starts the image, that `containerFetch` reaches the reader's
 * `/read`, and that `destroy` and `schedule` behave as the library documents.
 *
 * Runs on Node: the wall-time assertions read a clock the test moves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadPageResult, ReadPagesRequest } from "@breatic/shared";

/** What the stand-in base recorded for one instance. */
interface Recorded {
  events: string[];
  scheduled: { when: number; callback: string; payload: unknown }[];
  posted: { url: string; method: string; body: unknown }[];
}

const stand = vi.hoisted(() => {
  /** How the stand-in answers; each test sets these. */
  const behaviour = {
    startMs: 0,
    fetchMs: 0,
    start: (): Promise<void> => Promise.resolve(),
    answer: (): Promise<Response> => Promise.resolve(new Response(null, { status: 500 })),
  };
  /** Every instance constructed, newest last. */
  const instances: Recorded[] = [];

  /** Stand-in for `@cloudflare/containers`' `Container`. */
  class Container {
    recorded: Recorded = { events: [], scheduled: [], posted: [] };
    ctx: unknown;
    env: unknown;

    /**
     * Record the instance.
     * @param ctx - The object state.
     * @param env - The bindings.
     */
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
      instances.push(this.recorded);
    }

    /**
     * Record a schedule.
     * @param when - When it fires.
     * @param callback - The method it calls.
     * @param payload - What it passes.
     * @returns A schedule record.
     */
    schedule(when: Date | number, callback: string, payload?: unknown): Promise<{ id: string }> {
      this.recorded.events.push("schedule");
      this.recorded.scheduled.push({ when: when instanceof Date ? when.getTime() : when, callback, payload });
      return Promise.resolve({ id: "schedule-1" });
    }

    /**
     * Record a start, moving the clock by the start's cost.
     * @returns Nothing.
     */
    async start(): Promise<void> {
      this.recorded.events.push("start");
      vi.setSystemTime(Date.now() + behaviour.startMs);
      await behaviour.start();
    }

    /**
     * Same as `start`.
     * @returns Nothing.
     */
    startAndWaitForPorts(): Promise<void> {
      return this.start();
    }

    /**
     * Record a request into the container, moving the clock by its cost.
     * @param requestOrUrl - The request, or its URL.
     * @param portOrInit - The init when a URL was given.
     * @returns The stand-in's answer.
     */
    async containerFetch(requestOrUrl: Request | string | URL, portOrInit?: number | RequestInit): Promise<Response> {
      const request =
        requestOrUrl instanceof Request
          ? requestOrUrl
          : new Request(requestOrUrl, typeof portOrInit === "object" ? portOrInit : undefined);
      const text = await request.text();
      this.recorded.events.push("fetch");
      this.recorded.posted.push({ url: request.url, method: request.method, body: text === "" ? null : JSON.parse(text) });
      vi.setSystemTime(Date.now() + behaviour.fetchMs);
      return behaviour.answer();
    }

    /**
     * Record a destroy.
     * @returns Nothing.
     */
    destroy(): Promise<void> {
      this.recorded.events.push("destroy");
      return Promise.resolve();
    }
  }

  return { behaviour, instances, Container };
});

vi.mock("@cloudflare/containers", () => ({ Container: stand.Container }));

const { WebReaderContainer } = await import("@ingest/web-reader-container.js");

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

const REQUEST: ReadPagesRequest = {
  urls: ["https://example.com/a", "https://example.org/report.pdf"],
  deadlineAt: T0 + 90_000,
  pageTimeoutMs: 20_000,
  settleMs: 8_000,
  concurrency: 6,
  maxBytes: 10_000_000,
};

const PAGES: ReadPageResult[] = [
  { url: "https://example.com/a", status: "ok", httpStatus: 200, finalUrl: "https://example.com/a", title: "A", kind: "html", text: "# A" },
  { url: "https://example.org/report.pdf", status: "ok", httpStatus: 200, kind: "pdf", pages: 3, text: "Report" },
];

/**
 * A fresh reader and what its base recorded.
 * @returns Both.
 */
function newReader(): { reader: InstanceType<typeof WebReaderContainer>; recorded: Recorded } {
  const reader = new WebReaderContainer({} as never, {});
  const recorded = stand.instances.at(-1);
  if (recorded === undefined) throw new Error("the stand-in base was not constructed");
  return { reader, recorded };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  stand.instances.length = 0;
  stand.behaviour.startMs = 200;
  stand.behaviour.fetchMs = 1_000;
  stand.behaviour.start = (): Promise<void> => Promise.resolve();
  stand.behaviour.answer = (): Promise<Response> => Promise.resolve(Response.json({ pages: PAGES, cpuUsec: 4_200_000 }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WebReaderContainer.read on success", () => {
  it("schedules the destroy, starts, posts once, then destroys, in that order", async () => {
    const { reader, recorded } = newReader();

    await reader.read(REQUEST);

    expect(recorded.events).toEqual(["schedule", "start", "fetch", "destroy"]);
  });

  it("posts the request to the container's /read", async () => {
    const { reader, recorded } = newReader();

    await reader.read(REQUEST);

    expect(recorded.posted).toHaveLength(1);
    expect(recorded.posted[0]?.method).toBe("POST");
    expect(new URL(recorded.posted[0]?.url ?? "").pathname).toBe("/read");
    expect(recorded.posted[0]?.body).toEqual(REQUEST);
  });

  it("returns the container's pages with the wall time the object measured", async () => {
    const { reader } = newReader();

    const answer = await reader.read(REQUEST);

    // 200 ms to start plus 1000 ms of reading, as the object's own clock saw it.
    expect(answer).toEqual({ pages: PAGES, usage: { wallMs: 1_200, cpuUsec: 4_200_000 } });
  });

  it("carries a container that could not read its CPU as null", async () => {
    stand.behaviour.answer = (): Promise<Response> => Promise.resolve(Response.json({ pages: PAGES, cpuUsec: null }));
    const { reader } = newReader();

    const answer = await reader.read(REQUEST);

    expect(answer.usage).toEqual({ wallMs: 1_200, cpuUsec: null });
  });
});

describe("WebReaderContainer.read's deadline", () => {
  it("schedules exactly one destroy after the call's deadline", async () => {
    const { reader, recorded } = newReader();

    await reader.read(REQUEST);

    expect(recorded.scheduled).toHaveLength(1);
    expect(recorded.scheduled[0]?.when).toBeGreaterThan(REQUEST.deadlineAt);
  });

  it("destroys the instance when the scheduled callback fires", async () => {
    // The read never finishes, as if the container hung.
    stand.behaviour.answer = (): Promise<Response> => new Promise<Response>(() => undefined);
    const { reader, recorded } = newReader();

    reader.read(REQUEST).catch(() => undefined);
    await vi.waitFor(() => expect(recorded.scheduled).toHaveLength(1));
    const { callback, payload } = recorded.scheduled[0]!;
    const fire = (reader as unknown as Record<string, (p: unknown) => Promise<void>>)[callback];
    expect(typeof fire).toBe("function");
    await fire!.call(reader, payload);

    expect(recorded.events.filter((event) => event === "destroy")).toHaveLength(1);
  });
});

describe("WebReaderContainer.read on failure", () => {
  it.each([
    ["the container answers 500", (): Promise<Response> => Promise.resolve(new Response("boom", { status: 500 }))],
    ["the request into the container throws", (): Promise<Response> => Promise.reject(new Error("connection reset"))],
    ["the container answers something that is not JSON", (): Promise<Response> => Promise.resolve(new Response("<html>", { status: 200 }))],
  ])("rejects and still destroys the instance when %s", async (_label, answer) => {
    stand.behaviour.answer = answer;
    const { reader, recorded } = newReader();

    await expect(reader.read(REQUEST)).rejects.toThrow();

    expect(recorded.events.at(-1)).toBe("destroy");
    expect(recorded.events.filter((event) => event === "destroy")).toHaveLength(1);
  });

  it("rejects and still destroys the instance when the container will not start", async () => {
    stand.behaviour.start = (): Promise<void> => Promise.reject(new Error("no capacity"));
    const { reader, recorded } = newReader();

    await expect(reader.read(REQUEST)).rejects.toThrow("no capacity");

    expect(recorded.events).toEqual(["schedule", "start", "destroy"]);
  });
});

describe("WebReaderContainer.stop: the caller has gone", () => {
  it("destroys the instance, and a read in progress then rejects rather than answers", async () => {
    // The container never answers, so only the stop can end the read.
    stand.behaviour.answer = (): Promise<Response> => new Promise<Response>(() => undefined);
    const { reader, recorded } = newReader();
    const outcome = reader.read(REQUEST).then(
      () => "resolved",
      () => "rejected",
    );
    await vi.waitFor(() => expect(recorded.events).toContain("fetch"));

    await reader.stop();

    expect(recorded.events).toContain("destroy");
    const stillPending = new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 1_000));
    await expect(Promise.race([outcome, stillPending])).resolves.toBe("rejected");
  });

  it("destroys the instance and does not throw when nothing is running", async () => {
    const { reader, recorded } = newReader();

    await expect(reader.stop()).resolves.toBeUndefined();

    expect(recorded.events).toEqual(["destroy"]);
  });
});

describe("WebReaderContainer's way out", () => {
  it("has no route to the internet but its outbound handler, over HTTPS too", () => {
    const { reader } = newReader();

    expect(reader.enableInternet).toBe(false);
    expect(reader.interceptHttps).toBe(true);
  });

  it("answers the browser's requests through webReaderOutbound", async () => {
    const handler = WebReaderContainer.outbound;
    expect(typeof handler).toBe("function");

    const response = await handler(
      new Request("http://169.254.169.254/latest/meta-data/"),
      {},
      { containerId: "c1", className: "WebReaderContainer", params: undefined },
    );

    expect(response.status).toBe(403);
  });
});
