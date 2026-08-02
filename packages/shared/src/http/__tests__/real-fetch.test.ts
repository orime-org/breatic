// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The six items, against a real server and the real `fetch`.
 *
 * There is no other kind of test here any more, and that is a consequence of
 * the design rather than a preference. The layer takes no injected fetch and no
 * injected wait, so there is nothing to substitute: every case below opens a
 * real port, sends real bytes and closes real sockets.
 *
 * What that buys is the thing the injected version could never have. When a
 * double stands in for the network, "what a real failure looks like" is only
 * ever asserted against a stand-in written by the same hand as the expectation.
 * A socket destroyed mid-response, a connection the OS refuses, a header the
 * platform parses its own way — none of that survives being hand-written.
 *
 * The cost is wall-clock: cases that exercise a replay really do back off. They
 * are kept few and deliberate for that reason.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, it, expect, afterEach } from "vitest";

import { httpRequest, HttpRetryError } from "@shared/http/request.js";

/** How each request to the stub server should be answered, in order. */
type Reply =
  | { kind: "status"; status: number; headers?: Record<string, string> }
  | { kind: "destroy" }
  | { kind: "silent" };

let running: Server | null = null;

afterEach(async () => {
  if (running !== null) {
    const server = running;
    running = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** What a stub server reports back about the traffic it saw. */
interface Stub {
  url: string;
  hits: () => number;
  methods: () => string[];
  bodies: () => string[];
}

/**
 * Start a server that plays back the given replies, one per request.
 * @param replies - What to answer, in arrival order.
 * @returns Its URL and what it observed.
 */
async function stubServer(replies: Reply[]): Promise<Stub> {
  let hit = 0;
  const methods: string[] = [];
  const bodies: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = replies[hit] ?? { kind: "status" as const, status: 500 };
    hit += 1;
    methods.push(req.method ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString());
      if (reply.kind === "destroy") {
        // Kill the socket mid-flight: the shape a real dropped connection has,
        // which no hand-written rejection reproduces faithfully.
        res.socket?.destroy();
        return;
      }
      if (reply.kind === "silent") return; // accepted, then nothing — the deadline must end it
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify({ status: reply.status }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    hits: (): number => hit,
    methods: (): string[] => methods,
    bodies: (): string[] => bodies,
  };
}

/** The whole options object: one fact, and nothing else to say. */
const REPLAYABLE = { replaySafe: true } as const;

describe("item 1 — send the request the caller asked for", () => {
  it("sends the caller's method and body, byte for byte", async () => {
    const stub = await stubServer([{ kind: "status", status: 200 }]);

    await httpRequest(stub.url, { method: "POST", body: "payload" }, REPLAYABLE);

    expect(stub.methods()).toEqual(["POST"]);
    expect(stub.bodies()).toEqual(["payload"]);
  });

  it("sends the same bytes again on a replay", async () => {
    const stub = await stubServer([{ kind: "status", status: 503 }, { kind: "status", status: 200 }]);

    await httpRequest(stub.url, { method: "POST", body: "payload" }, REPLAYABLE);

    expect(stub.bodies()).toEqual(["payload", "payload"]);
  });

  it("ends a delivery the server never answers, rather than waiting forever", async () => {
    // A server that accepts the socket and then says nothing — the one shape a
    // hand-written pending promise cannot reproduce, because it has no socket
    // behind it. Three deliveries, each cut off at its own deadline.
    const stub = await stubServer([{ kind: "silent" }, { kind: "silent" }, { kind: "silent" }]);

    const thrown = await httpRequest(stub.url, {}, REPLAYABLE).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(HttpRetryError);
    expect(stub.hits()).toBe(3);
  }, 60_000);

  it.each([
    "not-a-url",
    "ftp://files.test/thing",
    "data:text/plain,hello",
  ])("refuses %s at the boundary, before anything is delivered", async (url) => {
    const thrown = await httpRequest(url, {}, REPLAYABLE).catch((e: unknown) => e);

    // "It threw" is not the assertion, and used to be: with the scheme guard
    // disabled the ftp row still threw — after three futile deliveries and two
    // backoffs, measured at 1984ms — so the row was green whether the refusal
    // it names happened or not. What separates the two is WHICH error: ours
    // names itself and carries no attempt count. The data: row separates
    // differently again — let through, it resolves 200 without an HTTP round
    // trip at all, so nothing is thrown for `toThrow` to catch.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(HttpRetryError);
    expect((thrown as Error).message).toContain("http was given");
  });

  it("never lets a URL's own credentials into anything it throws", async () => {
    // `fetch` refuses a URL with credentials and quotes the whole raw url in
    // the TypeError it throws — password, query key and all. Measured before
    // the boundary refusal: the message was clean and the cause leaked both.
    const password = ["hunter2", "SECRET"].join("");
    const thrown = await httpRequest(
      `https://user:${password}@api.test/v1?key=QUERYSECRET`,
      {},
      REPLAYABLE,
    ).catch((e: unknown) => e);

    const seen = `${(thrown as Error).message} ${String((thrown as Error).cause ?? "")} ${String((thrown as Error).stack ?? "")}`;
    expect(seen).not.toContain(password);
    expect(seen).not.toContain("QUERYSECRET");
  });
});

describe("item 2 — decide whether a replay is warranted", () => {
  it.each([429, 500, 503])("replays a %i", async (status) => {
    const stub = await stubServer([{ kind: "status", status }, { kind: "status", status: 200 }]);

    const out = await httpRequest(stub.url, {}, REPLAYABLE);

    expect(stub.hits()).toBe(2);
    expect(out.status).toBe(200);
  }, 20_000);

  it.each([400, 404, 422])("does not replay a %i", async (status) => {
    const stub = await stubServer([{ kind: "status", status }, { kind: "status", status: 200 }]);

    const out = await httpRequest(stub.url, {}, REPLAYABLE);

    expect(stub.hits()).toBe(1);
    expect(out.status).toBe(status);
  });

  it("replays a real dropped connection", async () => {
    const stub = await stubServer([{ kind: "destroy" }, { kind: "status", status: 200 }]);

    const out = await httpRequest(stub.url, {}, REPLAYABLE);

    expect(stub.hits()).toBe(2);
    expect(out.status).toBe(200);
  }, 20_000);

  it("does not replay when the caller says a second delivery has side effects", async () => {
    const stub = await stubServer([{ kind: "status", status: 503 }, { kind: "status", status: 200 }]);

    const out = await httpRequest(stub.url, { method: "POST" }, { replaySafe: false });

    expect(stub.hits()).toBe(1);
    expect(out.status).toBe(503);
  });

  it("replays a 429 even when the caller says a second delivery has side effects", async () => {
    // 429 states the server did NOT process the request, so a replay cannot
    // produce a second side effect — the caller's declaration does not apply.
    const stub = await stubServer([{ kind: "status", status: 429 }, { kind: "status", status: 200 }]);

    const out = await httpRequest(stub.url, { method: "POST" }, { replaySafe: false });

    expect(stub.hits()).toBe(2);
    expect(out.status).toBe(200);
  }, 20_000);

  it("does not replay a body whose bytes are already gone", async () => {
    // A transferred buffer passes `instanceof ArrayBuffer` while holding
    // nothing at all, so it was replayed three times — a body that cannot be
    // delivered even once.
    const buffer = new ArrayBuffer(8);
    structuredClone(buffer, { transfer: [buffer] });
    const stub = await stubServer([{ kind: "status", status: 503 }, { kind: "status", status: 200 }]);

    const thrown = await httpRequest(stub.url, { method: "POST", body: buffer }, REPLAYABLE).catch(
      (e: unknown) => e,
    );

    // fetch cannot even read it, so the first delivery fails outright — and
    // because no replay is warranted, that failure arrives unwrapped rather
    // than as a count-carrying error after three futile attempts.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(HttpRetryError);
    expect(stub.hits()).toBe(0);
  });

  it("does not replay a streamed body, which the first delivery consumed", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    const stub = await stubServer([{ kind: "status", status: 503 }, { kind: "status", status: 200 }]);

    const out = await httpRequest(
      stub.url,
      // `duplex` is required by the spec for a streamed request body.
      { method: "POST", body: stream, duplex: "half" } as RequestInit,
      REPLAYABLE,
    );

    expect(stub.hits()).toBe(1);
    expect(out.status).toBe(503);
  });
});

describe("item 3 — wait as long as the server said", () => {
  it("serves a real Retry-After header from a real response", async () => {
    const stub = await stubServer([
      { kind: "status", status: 429, headers: { "retry-after": "2" } },
      { kind: "status", status: 200 },
    ]);

    const started = Date.now();
    const out = await httpRequest(stub.url, {}, REPLAYABLE);
    const elapsed = Date.now() - started;

    expect(out.status).toBe(200);
    // Two seconds is well past the sub-second jitter the first replay would
    // otherwise use, so this cannot pass without the header being read.
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
  }, 20_000);

  it("stops rather than serving a wait past the ceiling, handing the response back", async () => {
    const stub = await stubServer([{ kind: "status", status: 429, headers: { "retry-after": "86400" } }]);

    const out = await httpRequest(stub.url, {}, REPLAYABLE);

    expect(stub.hits()).toBe(1);
    expect(out.status).toBe(429);
    // The figure is still there for a caller that wants it — this layer does
    // not relay it, because the response already carries it.
    expect(out.headers.get("retry-after")).toBe("86400");
  });
});

describe("item 4 — deliver at most three times", () => {
  it("stops after three deliveries when every one fails", async () => {
    const stub = await stubServer([
      { kind: "status", status: 503 },
      { kind: "status", status: 503 },
      { kind: "status", status: 503 },
      { kind: "status", status: 200 },
    ]);

    const out = await httpRequest(stub.url, {}, REPLAYABLE);

    expect(stub.hits()).toBe(3);
    expect(out.status).toBe(503);
  }, 20_000);
});

describe("item 5 — hand the response over, or throw", () => {
  it("returns the native Response, and its body is readable", async () => {
    const stub = await stubServer([{ kind: "status", status: 200 }]);

    const out = await httpRequest(stub.url, {}, REPLAYABLE);

    expect(out).toBeInstanceOf(Response);
    await expect(out.json()).resolves.toEqual({ status: 200 });
  });

  it("returns a failing response rather than throwing, because a response is an answer", async () => {
    const stub = await stubServer([{ kind: "status", status: 404 }]);

    const out = await httpRequest(stub.url, {}, REPLAYABLE);

    expect(out.status).toBe(404);
  });

  it("rethrows the platform's own error untouched when the first delivery failed alone", async () => {
    // Nothing is listening, and a non-replay-safe request warrants no replay,
    // so the caller must receive exactly what the platform threw.
    const stub = await stubServer([]);
    const { url } = stub;
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = null;

    const thrown = await httpRequest(url, { method: "POST" }, { replaySafe: false }).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(HttpRetryError);
  });

  it("throws a count-carrying error when replays happened and nothing came back", async () => {
    const stub = await stubServer([{ kind: "destroy" }, { kind: "destroy" }, { kind: "destroy" }]);

    const thrown = await httpRequest(stub.url, {}, REPLAYABLE).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(HttpRetryError);
    expect((thrown as HttpRetryError).attempts).toBe(3);
    // Whatever the platform throws for a destroyed socket is what the caller
    // can reach — not a message this layer invented about it.
    expect((thrown as HttpRetryError).cause).toBeInstanceOf(Error);
  }, 20_000);

  it("keeps a query key out of the message on the throwing path", async () => {
    const stub = await stubServer([]);
    const { url } = stub;
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = null;

    const thrown = await httpRequest(`${url}v1?key=AIzaSyFAKE_KEY_VALUE`, {}, REPLAYABLE).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(HttpRetryError);
    expect((thrown as Error).message).not.toContain("AIzaSyFAKE_KEY_VALUE");
    expect((thrown as Error).message).toContain("127.0.0.1");
  }, 20_000);
});

describe("item 6 — hold nothing once the call is over", () => {
  /**
   * How many timers this process is currently holding.
   *
   * Counting handles cannot isolate ours — vitest keeps timers of its own —
   * so every case below asks the only question that survives that noise: after
   * a batch of completed calls, is the count where it started? A deadline left
   * armed would show up as the batch size.
   * @returns The number of active Timeout handles.
   */
  const armedTimers = (): number =>
    process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

  it("clears the deadline on the path that returns early", async () => {
    const stub = await stubServer(
      Array.from({ length: 100 }, () => ({ kind: "status" as const, status: 200 })),
    );
    const before = armedTimers();

    for (let i = 0; i < 100; i++) await httpRequest(stub.url, {}, REPLAYABLE);

    expect(armedTimers()).toBeLessThanOrEqual(before);
  }, 30_000);

  it("clears the deadline on the path that goes the long way round", async () => {
    // A 200 returns from inside the try block, so it is the one path that
    // proves least — the deadline it leaves would be cleared by the next line
    // whether or not the cleanup were in a finally. A 404 walks out through
    // the decision instead, and this is the case that used to be missing:
    // moving the cleanup onto the success return left every one of these
    // hundred deadlines armed for its full ten seconds, and the old test
    // stayed green.
    const stub = await stubServer(
      Array.from({ length: 100 }, () => ({ kind: "status" as const, status: 404 })),
    );
    const before = armedTimers();

    for (let i = 0; i < 100; i++) await httpRequest(stub.url, {}, REPLAYABLE);

    expect(armedTimers()).toBeLessThanOrEqual(before);
  }, 30_000);

  it("clears the deadline of every delivery when the call replays and gives up", async () => {
    // Three deliveries per call, so three deadlines, and the two backoffs in
    // between are timers of their own. Nothing may outlive the call.
    const stub = await stubServer(
      Array.from({ length: 9 }, () => ({ kind: "status" as const, status: 503 })),
    );
    const before = armedTimers();

    for (let i = 0; i < 3; i++) await httpRequest(stub.url, {}, REPLAYABLE);

    expect(armedTimers()).toBeLessThanOrEqual(before);
  }, 60_000);

  it("clears the deadline when the call throws instead of returning", async () => {
    // The throwing path leaves the loop from a different statement again, and
    // an exception is exactly the shape that skips cleanup written anywhere
    // but a finally.
    const stub = await stubServer(Array.from({ length: 9 }, () => ({ kind: "destroy" as const })));
    const before = armedTimers();

    for (let i = 0; i < 3; i++) {
      await httpRequest(stub.url, {}, REPLAYABLE).catch(() => undefined);
    }

    expect(armedTimers()).toBeLessThanOrEqual(before);
  }, 60_000);
});
