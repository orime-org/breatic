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
    /** How `startAndWaitForPorts` settles; by default the same as `start`. */
    portsStart: (): Promise<void> => behaviour.start(),
    /** When a schedule's promise settles. */
    schedule: (): Promise<void> => Promise.resolve(),
    answer: (): Promise<Response> => Promise.resolve(new Response(null, { status: 500 })),
    destroy: (): Promise<void> => Promise.resolve(),
  };
  /** Every instance constructed, newest last. */
  const instances: Recorded[] = [];
  /**
   * Class name to its outbound handlers, kept as `@cloudflare/containers`
   * 0.3.7 keeps them (`container.js:285-296`): the static `outbound` is a
   * getter and setter over this registry, so a class field or a static
   * property of the subclass would register nothing.
   */
  const outboundHandlersRegistry = new Map<string, Record<string, unknown>>();
  const defaultOutboundHandlerNameRegistry = new Map<string, string>();

  /** Stand-in for `@cloudflare/containers`' `Container`. */
  class Container {
    /**
     * The class's catch-all outbound handler, read from the registry.
     * @returns The handler, or undefined when none was registered.
     */
    static get outbound(): unknown {
      const handlerName = defaultOutboundHandlerNameRegistry.get(this.name);
      if (handlerName === undefined) return undefined;
      return outboundHandlersRegistry.get(this.name)?.[handlerName];
    }

    /**
     * Register the class's catch-all outbound handler.
     * @param handler - The handler.
     */
    static set outbound(handler: unknown) {
      const key = "__outbound__";
      const existing = outboundHandlersRegistry.get(this.name) ?? {};
      outboundHandlersRegistry.set(this.name, { ...existing, [key]: handler });
      defaultOutboundHandlerNameRegistry.set(this.name, key);
    }

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
    async schedule(when: Date | number, callback: string, payload?: unknown): Promise<{ id: string }> {
      this.recorded.events.push("schedule");
      this.recorded.scheduled.push({ when: when instanceof Date ? when.getTime() : when, callback, payload });
      await behaviour.schedule();
      return { id: "schedule-1" };
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
     * Record a start that waits for the ports, moving the clock by the
     * start's cost. Recorded apart from `start`, so a test can tell which one
     * the reader called.
     * @returns Nothing.
     */
    async startAndWaitForPorts(): Promise<void> {
      this.recorded.events.push("startAndWaitForPorts");
      vi.setSystemTime(Date.now() + behaviour.startMs);
      await behaviour.portsStart();
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
      return behaviour.destroy();
    }
  }

  return { behaviour, instances, outboundHandlersRegistry, defaultOutboundHandlerNameRegistry, Container };
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

/** The id of every reader's Durable Object, as `ctx.id.toString()` gives it. */
const READER_ID = "web-reader-object-1";

/** What the stand-in records for the start the reader must call. */
const STARTED = "startAndWaitForPorts";

/**
 * A fresh reader and what its base recorded.
 * @returns Both.
 */
function newReader(): { reader: InstanceType<typeof WebReaderContainer>; recorded: Recorded } {
  const reader = new WebReaderContainer({ id: { toString: (): string => READER_ID } } as never, {});
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
  stand.behaviour.portsStart = (): Promise<void> => stand.behaviour.start();
  stand.behaviour.schedule = (): Promise<void> => Promise.resolve();
  stand.behaviour.answer = (): Promise<Response> => Promise.resolve(Response.json({ pages: PAGES, cpuUsec: 4_200_000 }));
  stand.behaviour.destroy = (): Promise<void> => Promise.resolve();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WebReaderContainer.read on success", () => {
  it("starts the container with startAndWaitForPorts, never a bare start", async () => {
    const { reader, recorded } = newReader();

    await reader.read(REQUEST);

    expect(recorded.events).toContain(STARTED);
    expect(recorded.events).not.toContain("start");
  });

  it("schedules the destroy, starts, posts once, then destroys, in that order", async () => {
    const { reader, recorded } = newReader();

    await reader.read(REQUEST);

    expect(recorded.events).toEqual(["schedule", STARTED, "fetch", "destroy"]);
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

    expect(recorded.events).toEqual(["schedule", STARTED, "destroy"]);
  });

  // Plan §9 row I: the route answers a start that failed with 503 and the
  // failure code `reader_not_started`. Workers RPC carries an error's message
  // across, not its class, so the message is what names it.
  it("names a start that failed reader_not_started, keeping the reason", async () => {
    stand.behaviour.start = (): Promise<void> => Promise.reject(new Error("no capacity"));
    const { reader } = newReader();

    const failure = await reader.read(REQUEST).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^reader_not_started\b/);
    expect((failure as Error).message).toContain("no capacity");
  });

  it("names a startAndWaitForPorts that failed reader_not_started, even when a bare start would succeed", async () => {
    stand.behaviour.portsStart = (): Promise<void> => Promise.reject(new Error("ports never opened"));
    const { reader } = newReader();

    const failure = await reader.read(REQUEST).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^reader_not_started\b/);
    expect((failure as Error).message).toContain("ports never opened");
  });

  it("carries the service's own words when it answers other than 2xx", async () => {
    stand.behaviour.answer = (): Promise<Response> =>
      Promise.resolve(new Response("chromium failed to launch", { status: 500 }));
    const { reader } = newReader();

    await expect(reader.read(REQUEST)).rejects.toThrow(/chromium failed to launch/);
  });

  it("carries at most the first 500 characters of that answer", async () => {
    const body = `${"a".repeat(500)}${"b".repeat(500)}`;
    stand.behaviour.answer = (): Promise<Response> => Promise.resolve(new Response(body, { status: 502 }));
    const { reader } = newReader();

    const failure = await reader.read(REQUEST).then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(failure?.message).toContain("a".repeat(500));
    expect(failure?.message).not.toContain("b");
  });

  it("does not name a failure after the start reader_not_started", async () => {
    stand.behaviour.answer = (): Promise<Response> => Promise.reject(new Error("connection reset"));
    const { reader } = newReader();

    const failure = await reader.read(REQUEST).then(
      () => null,
      (err: unknown) => err,
    );

    expect((failure as Error).message).not.toMatch(/reader_not_started/);
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

/**
 * A start that settles only when the test says so.
 * @returns The start to install, and its two settlers.
 */
function startHeldOpen(): { start: () => Promise<void>; resolve: () => void; reject: (reason: Error) => void } {
  let resolve: () => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const pending = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { start: () => pending, resolve, reject };
}

/**
 * Let every queued promise callback run.
 * @returns Nothing.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// Plan §9 row H: destroying while `start()` is still on its way leaves the
// start to finish after the destroy and the container running with nobody to
// destroy it. The read's own `finally` is the one place that destroys, after
// the start has an outcome; `stop` and `expireRead` only end the read and
// wait for it to wrap up.
describe.each([
  ["stop", (reader: InstanceType<typeof WebReaderContainer>): Promise<void> => reader.stop()],
  ["expireRead", (reader: InstanceType<typeof WebReaderContainer>): Promise<void> => reader.expireRead()],
])("WebReaderContainer.%s while the container is still starting", (_name, end) => {
  it.each([
    ["the start then succeeds", (held: ReturnType<typeof startHeldOpen>): void => held.resolve()],
    ["the start then fails", (held: ReturnType<typeof startHeldOpen>): void => held.reject(new Error("no capacity"))],
  ])("destroys exactly once, only after the start settles, when %s, and the read rejects", async (_label, finish) => {
    const held = startHeldOpen();
    stand.behaviour.start = held.start;
    const { reader, recorded } = newReader();
    const outcome = reader.read(REQUEST).then(
      () => "resolved",
      () => "rejected",
    );
    await vi.waitFor(() => expect(recorded.events).toContain(STARTED));

    let ended = false;
    const ending = end(reader).then(() => {
      ended = true;
    });
    await settle();

    expect(recorded.events.filter((event) => event === "destroy")).toHaveLength(0);
    expect(ended).toBe(false);

    finish(held);
    await ending;

    expect(recorded.events.filter((event) => event === "destroy")).toHaveLength(1);
    expect(recorded.events).not.toContain("fetch");
    await expect(outcome).resolves.toBe("rejected");
  });
});

describe("WebReaderContainer's way out", () => {
  it("registers its handler in the library's outbound registry", () => {
    expect(stand.defaultOutboundHandlerNameRegistry.get("WebReaderContainer")).toBe("__outbound__");
    const handlers = stand.outboundHandlersRegistry.get("WebReaderContainer");
    expect(typeof handlers?.["__outbound__"]).toBe("function");
  });


  it("has no route to the internet but its outbound handler, over HTTPS too", () => {
    const { reader } = newReader();

    expect(reader.enableInternet).toBe(false);
    expect(reader.interceptHttps).toBe(true);
  });

  it("answers the browser's requests through webReaderOutbound", async () => {
    const handler = WebReaderContainer.outbound;
    expect(typeof handler).toBe("function");

    const response = await handler!(
      new Request("http://169.254.169.254/latest/meta-data/"),
      {},
      { containerId: "c1", className: "WebReaderContainer", params: undefined },
    );

    expect(response.status).toBe(403);
  });
});

// A destroy that failed leaves a container running until its own timeout:
// on-call must be able to see it, so it is noted, never swallowed.
describe("WebReaderContainer when the destroy fails", () => {
  it("notes it as ingest_web_reader_destroy_failed after a read, and the read still answers", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stand.behaviour.destroy = (): Promise<void> => Promise.reject(new Error("destroy refused"));
    const { reader } = newReader();

    await expect(reader.read(REQUEST)).resolves.toMatchObject({ pages: PAGES });

    expect(logged).toHaveBeenCalledWith(
      "ingest_web_reader_destroy_failed",
      expect.objectContaining({ containerId: READER_ID, err: expect.stringContaining("destroy refused") as unknown }),
    );
  });

  it("notes it when a stop destroys an idle instance, and the stop does not throw", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stand.behaviour.destroy = (): Promise<void> => Promise.reject(new Error("destroy refused"));
    const { reader } = newReader();

    await expect(reader.stop()).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(
      "ingest_web_reader_destroy_failed",
      expect.objectContaining({ containerId: READER_ID, err: expect.stringContaining("destroy refused") as unknown }),
    );
  });
});

// Plan §11 row 14: a stop that arrives while the deadline's destroy is still
// being scheduled must not wait for the schedule and then start a container
// nobody is waiting for.
describe("WebReaderContainer.stop while the destroy is still being scheduled", () => {
  it("never starts the container, rejects the read and destroys the instance", async () => {
    let scheduled: () => void = () => undefined;
    stand.behaviour.schedule = (): Promise<void> =>
      new Promise<void>((resolve) => {
        scheduled = resolve;
      });
    const { reader, recorded } = newReader();
    const outcome = reader.read(REQUEST).then(
      () => "resolved",
      () => "rejected",
    );
    await vi.waitFor(() => expect(recorded.events).toContain("schedule"));

    const stopping = reader.stop();
    await settle();
    // Let a reader still waiting on the schedule go on, so neither way hangs.
    scheduled();
    await stopping;

    await expect(outcome).resolves.toBe("rejected");
    expect(recorded.events).not.toContain("start");
    expect(recorded.events).not.toContain(STARTED);
    expect(recorded.events).not.toContain("fetch");
    expect(recorded.events.filter((event) => event === "destroy")).toHaveLength(1);
  });
});
