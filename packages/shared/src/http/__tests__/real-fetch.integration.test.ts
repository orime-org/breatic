// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { DEFAULT_TIMEOUT_MS } from "@shared/http/constants.js";

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
    // Force the sockets shut before closing. One case deliberately leaves a
    // request in flight — it is asserting that the default deadline does NOT
    // end it early — and `close` alone waits for that connection, which means
    // waiting out the whole default. Nothing else is affected: by the time a
    // finished test gets here, its connections are already gone.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** What a stub server reports back about the traffic it saw. */
interface Stub {
  url: string;
  hits: () => number;
  methods: () => string[];
  bodies: () => string[];
  /** Request headers as received, one record per delivery. */
  headers: () => Array<Record<string, string>>;
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
  const headers: Array<Record<string, string>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = replies[hit] ?? { kind: "status" as const, status: 500 };
    hit += 1;
    methods.push(req.method ?? "");
    headers.push(
      Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]),
      ),
    );
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
    headers: (): Array<Record<string, string>> => headers,
  };
}

/** The common case: replaying is free, and the default deadline will do. */
const REPLAYABLE = { replaySafe: true } as const;

describe("item 1 — send the request the caller asked for", () => {
  it("sends the caller's method and body, byte for byte", async () => {
    const stub = await stubServer([{ kind: "status", status: 200 }]);

    await httpRequest(stub.url, { method: "POST", body: "payload" }, REPLAYABLE);

    expect(stub.methods()).toEqual(["POST"]);
    expect(stub.bodies()).toEqual(["payload"]);
  });

  it("sends the caller's headers, and sends them again on a replay", async () => {
    // Item 1 says url and init go out unchanged, and headers are the part of
    // init that carries authorisation — yet nothing used to look at them:
    // handing fetch only `{ method, body }` and dropping the rest left every
    // test green. A vendor key silently not sent is a request that fails for
    // a reason nobody can see from here.
    const stub = await stubServer([{ kind: "status", status: 503 }, { kind: "status", status: 200 }]);

    await httpRequest(
      stub.url,
      { method: "POST", body: "payload", headers: { "x-api-key": "K", "content-type": "text/plain" } },
      REPLAYABLE,
    );

    expect(stub.headers()).toHaveLength(2);
    for (const received of stub.headers()) {
      expect(received["x-api-key"]).toBe("K");
      expect(received["content-type"]).toBe("text/plain");
    }
  });

  it("lets an https URL through the boundary and out onto the network", async () => {
    // Nothing in this suite ever sent one, so the layer could be made to
    // refuse https entirely — a one-word change — and all 118 tests stayed
    // green. https is the scheme every real caller uses.
    //
    // The request is expected to fail, and WHICH failure is the assertion:
    // "connection refused" is the network answering, so the URL got past our
    // guard and was really dialled. Narrowing the guard to http-only makes the
    // message start with "http was given" instead.
    //
    // The port is chosen with care. This used to dial port 1, described in this
    // comment as "no server on that port" — measured, that is wrong: 1 is on
    // the blocked-port list, so fetch refuses with `bad port` WITHOUT dialling
    // anything, and the test could not tell a working transport from one that
    // never reached the network. A high unbound port really is refused by the
    // OS, which is the fact this needs.
    const thrown = await httpRequest(
      "https://127.0.0.1:45999/nothing-listens-here",
      {},
      { replaySafe: false },
    ).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain("http was given");
    expect(String((thrown as Error).cause ?? "")).toContain("ECONNREFUSED");
  }, 30_000);

  it("replaces a signal the caller put in init, and delivers anyway", async () => {
    // The docstring promises init's own signal is replaced by this call's
    // deadline. Reversing the spread — letting the caller's signal win — kept
    // every test green, because no test ever passed one. An already-aborted
    // signal is the sharpest version: if it survived, nothing would be
    // delivered at all.
    const stub = await stubServer([{ kind: "status", status: 200 }]);

    const out = await httpRequest(
      stub.url,
      { signal: AbortSignal.abort() },
      { replaySafe: true },
    );

    expect(out.status).toBe(200);
    expect(stub.hits()).toBe(1);
  }, 30_000);

  it("sends the same bytes again on a replay", async () => {
    const stub = await stubServer([{ kind: "status", status: 503 }, { kind: "status", status: 200 }]);

    await httpRequest(stub.url, { method: "POST", body: "payload" }, REPLAYABLE);

    expect(stub.bodies()).toEqual(["payload", "payload"]);
  });

  it("carries an upload that takes longer than a person would wait", async () => {
    // The case the old ten-second figure made impossible rather than slow: a
    // healthy server reading an ordinary upload at an ordinary rate. Measured
    // under the old value: three deliveries, none of them ever completing.
    // Nothing here is stalled — every chunk arrives — so nothing may cut it
    // off.
    const payload = new Uint8Array(4 * 1024 * 1024);
    let received = 0;
    const server = createServer((req, res) => {
      req.on("data", (c: Buffer) => {
        received += c.length;
        req.pause();
        setTimeout(() => req.resume(), 250); // throttle: ~16s for the whole body
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      req.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    running = server;
    const { port } = server.address() as AddressInfo;

    const started = Date.now();
    const out = await httpRequest(
      `http://127.0.0.1:${port}/`,
      { method: "POST", body: payload },
      REPLAYABLE,
    );

    expect(out.status).toBe(200);
    expect(received).toBe(payload.byteLength);
    // The assertion that pins the defect: it took longer than the old figure.
    expect(Date.now() - started).toBeGreaterThan(10_000);
  }, 120_000);

  it.each([
    ["a string that is not a URL", (s: string): string => `key=${s}&not-a-url`],
    ["a scheme this transport does not speak", (s: string): string => `ftp://files.test/${s}`],
    ["a data URL, which is not an HTTP round trip", (s: string): string => `data:text/plain,${s}`],
  ])("refuses %s at the boundary, before anything is delivered", async (_label, build) => {
    // Each input carries a secret, because this case asserts two things at
    // once and the second used to live in redact-url.test.ts: the refusal
    // happens, AND it quotes none of what it refused. Redaction can no longer
    // be the thing that protects these — it never sees them now — so the
    // property is asserted here, where it actually holds.
    const secret = ["MY-SECRET", "PAYLOAD"].join("-");
    const thrown = await httpRequest(build(secret), {}, REPLAYABLE).catch((e: unknown) => e);

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

    const seen = `${(thrown as Error).message} ${String((thrown as Error).cause ?? "")} ${String((thrown as Error).stack ?? "")}`;
    expect(seen).not.toContain(secret);
  });

  // Three shapes, because the guard asks two questions and each needs an input
  // that only IT answers. The first two rows both have a non-empty username,
  // so between them the password half never once decided anything — deleting
  // it left the suite green. The third row is the one that decides it:
  // `https://:secret@host` parses to an empty username and a password, and
  // fetching it leaks the password and the query key into `cause`.
  it.each([
    ["a password beside a username", (s: string): string => `https://user:${s}@api.test/v1?key=QUERYSECRET`],
    ["a bare username", (s: string): string => `https://${s}@api.test/v1?key=QUERYSECRET`],
    ["a password with no username", (s: string): string => `https://:${s}@api.test/v1?key=QUERYSECRET`],
  ])("never lets %s in the URL reach anything it throws", async (_shape, build) => {
    // `fetch` refuses a URL with credentials and quotes the whole raw url in
    // the TypeError it throws — secret, query key and all. Measured before
    // the boundary refusal: the message was clean and the cause leaked both.
    const secret = ["hunter2", "SECRET"].join("");
    const thrown = await httpRequest(build(secret), {}, REPLAYABLE).catch((e: unknown) => e);

    const seen = `${(thrown as Error).message} ${String((thrown as Error).cause ?? "")} ${String((thrown as Error).stack ?? "")}`;
    expect(seen).not.toContain(secret);
    expect(seen).not.toContain("QUERYSECRET");
    // And it must be the boundary refusal that stopped it, not three futile
    // deliveries: a leak reaches the caller either way, but only one of those
    // means the guard ran.
    expect(thrown).not.toBeInstanceOf(HttpRetryError);
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

  it("replays a delivery that ran out of time", async () => {
    // The most ordinary retry there is — one delivery stalls, the next one
    // works — and nothing covered it. Hoisting the deadline out of the loop, so
    // that a timed-out delivery can never be followed by another, left all 127
    // tests green: the call it broke ended in HttpRetryError with the server
    // having seen one request instead of two.
    //
    // What makes this case its own: every other replay here starts from a
    // response or a dead socket, and this one starts from our own abort. The
    // controller is built inside the loop for exactly this reason — an
    // AbortSignal fires once and stays fired, so one shared across deliveries
    // kills every later one before it leaves the ground.
    const stub = await stubServer([{ kind: "silent" }, { kind: "status", status: 200 }]);

    const out = await httpRequest(stub.url, {}, { replaySafe: true, timeoutMs: 400 });

    expect(out.status).toBe(200);
    expect(stub.hits()).toBe(2);
  }, 30_000);

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

describe("how long one delivery may take", () => {
  it("uses the deadline the caller gave", async () => {
    // The caller knows things this layer cannot: that this vendor is slow,
    // that this file is 2 GB. Measured against a server that accepts the
    // socket and answers nothing, a 500ms deadline must end the call in well
    // under the default.
    const stub = await stubServer([{ kind: "silent" }]);
    const started = Date.now();

    const thrown = await httpRequest(
      stub.url,
      {},
      { replaySafe: false, timeoutMs: 500 },
    ).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(stub.hits()).toBe(1);
  }, 30_000);

  it.each([
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["zero", 0],
    ["negative", -1],
    ["past what a timer can hold", 2_147_483_648],
    ["a figure under one millisecond", 0.5],
  ])("refuses a deadline of %s instead of turning it into 1ms", async (_label, timeoutMs) => {
    // A timer rewrites a delay it cannot hold to ONE MILLISECOND, with a
    // warning on stderr and nothing else. Measured on Node 24 against a healthy
    // server answering in 50ms: Infinity, NaN, zero, -1 and 2_147_483_648 each
    // ended in three aborted deliveries and no response, while 30_000 and nine
    // hours both returned 200. So a caller computing its own deadline — which
    // is what this layer asks callers to do, and `size / rate` yields Infinity
    // the moment a rate is zero — gets the exact opposite of what it asked for,
    // on a server that was working fine.
    //
    // 0.5 is here for a different reason: it truncates to zero, which the timer
    // then treats as the same unusable case. Fractions at or above one are NOT
    // in this list and must not be — see the case below.
    //
    // Refusing here rather than at the timer is the same rule the URL guard
    // follows: something unusable arrived, so say so before spending three
    // deliveries proving it.
    const stub = await stubServer([{ kind: "status", status: 200 }]);

    const thrown = await httpRequest(stub.url, {}, { replaySafe: true, timeoutMs }).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(HttpRetryError);
    expect((thrown as Error).message).toContain("http was given");
    expect(stub.hits()).toBe(0);
  }, 30_000);

  it("accepts a deadline carrying a fraction, and honours it", async () => {
    // Computing a deadline is what this layer asks callers to do, and the
    // arithmetic that does it — bytes over a rate, times a thousand — produces
    // fractions constantly. A timer truncates them and works: measured on Node
    // 24, 1500.75 fired at 1500ms and 300000.5 at 300011ms, both perfectly
    // usable. Only values it cannot hold at all become 1ms.
    //
    // This case exists because the guard above once read `Number.isInteger` and
    // refused every fraction, on a stated reason — "a timer rewrites all of
    // these to 1ms" — that had been measured for the other values and merely
    // assumed for this one. A caller sizing a deadline off a file would have
    // been refused outright.
    const stub = await stubServer([{ kind: "silent" }]);
    const started = Date.now();

    const thrown = await httpRequest(
      stub.url,
      {},
      { replaySafe: false, timeoutMs: 400.75 },
    ).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    // It reached the network and ran out of time there, rather than being
    // turned away at the boundary.
    expect((thrown as Error).message).toContain("timed out");
    expect(stub.hits()).toBe(1);
    // Truncated to 400ms, not rewritten to 1ms: comfortably past a millisecond
    // and nowhere near the 300s default.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(3_000);
  }, 30_000);

  it("keeps a query key out of the timeout message", async () => {
    // The timeout message is composed here, so it is one of the two places a
    // raw url could reach a log — and the only one no test looked at. Swapping
    // the redacted url for the raw one in that one line left the suite green
    // while handing the caller a live API key through the error's cause.
    const stub = await stubServer([{ kind: "silent" }]);
    const secret = ["AIzaSy", "REAL-LOOKING-KEY"].join("");

    const thrown = await httpRequest(
      `${stub.url}v1/models?key=${secret}`,
      {},
      { replaySafe: false, timeoutMs: 500 },
    ).catch((e: unknown) => e);

    const seen = `${(thrown as Error).message} ${String((thrown as Error).cause ?? "")} ${String((thrown as Error).stack ?? "")}`;
    expect(seen).not.toContain(secret);
    expect(seen).toContain("timed out");
  }, 30_000);

  it("falls back to the default when the caller gives none", async () => {
    // The guard against the default being quietly shortened: a call with no
    // deadline of its own is still in flight after a second and a half.
    // Anything short enough to end here would be this layer deciding for the
    // caller again.
    expect(DEFAULT_TIMEOUT_MS).toBe(300_000);

    const stub = await stubServer([{ kind: "silent" }]);
    let settled = false;
    void httpRequest(stub.url, {}, { replaySafe: false })
      .catch(() => undefined)
      .then(() => {
        settled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(settled).toBe(false);
    expect(stub.hits()).toBe(1);
  }, 30_000);
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

  it("serves the wait a 503 asked for, not only a 429", async () => {
    // The header is honoured by whether a figure arrived, never by which status
    // carried it — and only 429 was ever tested. Narrowing the code to 429 and
    // 408 left every test green, while a 503 asking for three seconds was
    // replayed after 274ms.
    const stub = await stubServer([
      { kind: "status", status: 503, headers: { "retry-after": "2" } },
      { kind: "status", status: 200 },
    ]);

    const started = Date.now();
    const out = await httpRequest(stub.url, {}, REPLAYABLE);

    expect(out.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  }, 20_000);

  it("serves a wait named as a date, measured against the clock", async () => {
    // The date form is the difference between an instant and now, so the loop
    // hands the parser the current time. Replacing that argument with zero left
    // every test green: the header then reads as 56 years out, trips the
    // ceiling, and the request stops after a single delivery. The unit tests
    // for the parser could not catch it — they pass their own clock in.
    const at = new Date(Date.now() + 3_000);
    at.setMilliseconds(0);
    const stub = await stubServer([
      { kind: "status", status: 503, headers: { "retry-after": at.toUTCString() } },
      { kind: "status", status: 200 },
    ]);

    const started = Date.now();
    const out = await httpRequest(stub.url, {}, REPLAYABLE);
    const elapsed = Date.now() - started;

    expect(out.status).toBe(200);
    expect(stub.hits()).toBe(2);
    // The header names an instant to the second, so the wait lands between two
    // and three seconds — either way past the sub-second jitter of a first
    // replay, which is what this has to be told apart from.
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
  }, 20_000);

  it("reads a header the server padded with spaces", async () => {
    // Measured: the parser eats the space after the colon and keeps the one
    // before the line ending, so a value sent as "  2  " arrives as "2  ".
    // Without the trim it matches no legal form at all, the server's figure is
    // discarded, and the polite path quietly becomes sub-second jitter — with
    // every test still green.
    const stub = await stubServer([
      { kind: "status", status: 503, headers: { "retry-after": "  2  " } },
      { kind: "status", status: 200 },
    ]);

    const started = Date.now();
    const out = await httpRequest(stub.url, {}, REPLAYABLE);

    expect(out.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
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

    // Catch what the platform throws for this exact call, so the assertion can
    // be identity rather than resemblance. "It is an Error and not a
    // HttpRetryError" was the old pair, and wrapping the failure in a fresh
    // Error satisfied both — the test named the property and could not see it
    // broken.
    const fromPlatform = await fetch(url, { method: "POST" }).catch((e: unknown) => e);

    const thrown = await httpRequest(url, { method: "POST" }, { replaySafe: false }).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(HttpRetryError);
    // Untouched means untouched: same constructor, same message, same cause.
    // Compared by content, not identity — two calls produce two objects. A
    // wrapper fails all three: its message would name this layer, and its
    // cause would BE the platform error rather than matching the platform's
    // own cause.
    expect((thrown as Error).constructor).toBe((fromPlatform as Error).constructor);
    expect((thrown as Error).message).toBe((fromPlatform as Error).message);
    expect(String((thrown as Error).cause)).toBe(String((fromPlatform as Error).cause));
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
    // hundred deadlines armed for its full duration, and the old test stayed
    // green. (The figure was ten seconds when this was written; the deadline
    // is the caller's now, defaulting to 300s, which only makes it worse.)
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
