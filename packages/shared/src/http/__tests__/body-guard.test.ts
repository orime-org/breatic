// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The response body must be read under its own idle deadline.
 *
 * This exists because the first cut of the shared transport lost a
 * protection the code it replaced had. Every one of the 27 call sites that
 * predated it passed `AbortSignal.timeout(n)` straight to `fetch` and never
 * cleared it, so that one deadline covered the body read as well. The
 * transport gave each attempt a deadline for the HEADERS and cleared it on
 * the way out, which is the right split — "wait for headers" and "read the
 * body" are different waits and every mature client times them separately
 * (Go's ResponseHeaderTimeout vs Timeout; undici's headersTimeout vs
 * bodyTimeout; python-requests' connect vs read). What was missing is the
 * second deadline, so a server that flushed headers and then went silent
 * hung us forever.
 *
 * The semantic is IDLE, not total (decided 2026-07-30): the clock measures
 * the gap between chunks, so a slow 500 MB asset download is not killed for
 * being slow while a half-dead connection still gets cut. Measured
 * feasibility of doing this in portable `fetch`:
 * `engineering/demo/2026-07-30-body-idle-timeout-probe.mjs`.
 *
 * These tests drive a body that arrives in controlled chunks. A buffered
 * `new Response("...")` — what every pre-existing test in this directory
 * uses — cannot reproduce a stall at all, which is exactly why the
 * regression was invisible to a green suite.
 */

import { describe, it, expect } from "vitest";

import { httpRequest } from "@shared/http/request.js";

const URL_UNDER_TEST = "https://vendor.test/v1/generate";

/** A body that arrives only when the test says so. */
function streamingBody(status = 200): {
  response: Response;
  push: (chunk: string) => void;
  finish: () => void;
} {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream, {
      status,
      headers: { "content-type": "application/json" },
    }),
    push: (chunk: string): void => ctrl.enqueue(encoder.encode(chunk)),
    finish: (): void => ctrl.close(),
  };
}

/** A fetch that returns one prepared response. */
function fetchReturning(response: Response): typeof fetch {
  return (() => Promise.resolve(response)) as unknown as typeof fetch;
}

/** Options with both deadlines set, headers generous and body tight. */
function opts(fetchImpl: typeof fetch, bodyIdleMs = 120): Parameters<typeof httpRequest>[2] {
  return {
    replaySafe: true,
    timeoutMs: 5_000,
    bodyIdleTimeoutMs: bodyIdleMs,
    fetchImpl,
    label: "probe",
  };
}

describe("response body idle deadline", () => {
  it("rejects a body that goes silent for longer than the idle deadline", async () => {
    const { response, push } = streamingBody();
    push('{"partial":');
    // Nothing else is ever pushed: headers arrived, the body stalls.

    const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchReturning(response)));

    await expect(res.text()).rejects.toThrow(/idle/i);
  });

  it("does NOT reject a slow body that keeps trickling — idle, not total", async () => {
    const { response, push, finish } = streamingBody();
    // Six chunks at 60ms apart with a 120ms idle deadline: total elapsed
    // (~360ms) far exceeds the deadline, but no single gap does. A total
    // deadline would kill this; an idle deadline must not.
    void (async () => {
      for (let i = 0; i < 6; i += 1) {
        push(`"chunk${i}",`);
        await new Promise((r) => setTimeout(r, 60));
      }
      finish();
    })();

    const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchReturning(response)));
    const text = await res.text();

    expect(text).toContain("chunk0");
    expect(text).toContain("chunk5");
  });

  it("guards json() the same way it guards text()", async () => {
    const { response, push } = streamingBody();
    push('{"id":');

    const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchReturning(response)));

    await expect(res.json()).rejects.toThrow(/idle/i);
  });

  it("guards arrayBuffer() — the audio vendors read raw bytes", async () => {
    const { response, push } = streamingBody();
    push("ID3");

    const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchReturning(response)));

    await expect(res.arrayBuffer()).rejects.toThrow(/idle/i);
  });

  it("guards stream() — the asset download writes to disk chunk by chunk", async () => {
    const { response, push } = streamingBody();
    push("bytes");

    const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchReturning(response)));
    const reader = res.stream().getReader();

    // First chunk is already buffered, so it arrives.
    const first = await reader.read();
    expect(first.done).toBe(false);
    // The second never comes, so the idle deadline must surface here.
    await expect(reader.read()).rejects.toThrow(/idle/i);
  });

  it("streams a complete body through to the end when it does arrive", async () => {
    const { response, push, finish } = streamingBody();
    push("part1");
    push("part2");
    finish();

    const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchReturning(response)));
    const chunks: string[] = [];
    const reader = res.stream().getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks.join("")).toBe("part1part2");
  });

  it("surfaces the caller's cancellation while the body is being read", async () => {
    const { response, push } = streamingBody();
    push('{"partial":');
    const controller = new AbortController();

    const res = await httpRequest(URL_UNDER_TEST, {}, {
      ...opts(fetchReturning(response), 5_000),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("user pressed stop")), 30);

    await expect(res.text()).rejects.toThrow(/user pressed stop/);
  });

  it("reports the idle deadline, not the abort the deadline itself triggers", async () => {
    // A real fetch body errors the moment its request is aborted, and that
    // rejection races the deadline's own. Tearing down before rejecting let
    // the stream's bare "aborted" win, leaving the caller unable to tell a
    // stalled body from its own cancellation. Caught against a real socket:
    // the streams above ignore aborts, so they cannot expose the ordering.
    const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          signal?.addEventListener("abort", () => {
            controller.error(new DOMException("This operation was aborted", "AbortError"));
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as unknown as typeof fetch;

    const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchImpl));

    await expect(res.text()).rejects.toThrow(/idle timeout/);
  });

  it("reports the caller's cancellation, not the abort it triggers", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          signal?.addEventListener("abort", () => {
            controller.error(new DOMException("This operation was aborted", "AbortError"));
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as unknown as typeof fetch;
    const controller = new AbortController();

    const res = await httpRequest(URL_UNDER_TEST, {}, {
      ...opts(fetchImpl, 5_000),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("user pressed stop")), 30);

    await expect(res.text()).rejects.toThrow(/user pressed stop/);
  });

  it("cancelling the stream leaves no unhandled rejection", async () => {
    // Cancelling used to tear the request down first, which errors the source
    // body; the spec then has `cancel()` on an errored stream return a
    // rejected promise, and that rejection was left floating. Node terminates
    // the process for an unhandled rejection, so a consumer that merely broke
    // out of a `for await` — or whose disk filled mid-write — killed the whole
    // worker with every other job in flight. Measured in a child process:
    // `engineering/demo/2026-07-30-stream-cancel-crash-repro.ts`.
    const rejections: unknown[] = [];
    const capture = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", capture);

    try {
      const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            // A real body errors when its request is aborted. Without this the
            // cancel path cannot reject and the defect is invisible.
            signal?.addEventListener("abort", () => {
              controller.error(new DOMException("This operation was aborted", "AbortError"));
            });
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }) as unknown as typeof fetch;

      const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchImpl, 5_000));
      const reader = res.stream().getReader();
      await reader.read();
      await reader.cancel(new Error("consumer stopped early"));

      // Let the microtask queue drain so any floating rejection surfaces.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", capture);
    }
  });

  it("refuses a second read instead of answering with nothing", async () => {
    // A one-shot resource read twice used to return an empty string, turning a
    // caller's mistake into a plausible value. The platform's own `Response`
    // throws, and the interface claims the same rule, so it has to hold.
    const { response, push, finish } = streamingBody();
    push("payload");
    finish();

    const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchReturning(response)));
    expect(await res.text()).toBe("payload");

    await expect(res.text()).rejects.toThrow(/already consumed/);
    await expect(res.json()).rejects.toThrow(/already consumed/);
    await expect(res.arrayBuffer()).rejects.toThrow(/already consumed/);
    expect(() => res.stream()).toThrow(/already consumed/);
  });

  it("tears the request down when cancelled before any read starts", async () => {
    // The transport's per-attempt listener retires when the headers land, and
    // the read path only listens while a read is in flight. A caller that holds
    // the handle and cancels before reading used to leave the server streaming
    // to nobody, because nothing was watching in between.
    let aborted = false;
    const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as unknown as typeof fetch;
    const controller = new AbortController();

    // Take the handle and never read it — just cancel.
    await httpRequest(URL_UNDER_TEST, {}, {
      ...opts(fetchImpl, 5_000),
      signal: controller.signal,
    });
    expect(aborted).toBe(false);

    controller.abort(new Error("user pressed stop"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(aborted).toBe(true);
  });

  it("exposes the metadata callers actually use without handing out the raw response", async () => {
    const { response, push, finish } = streamingBody(503);
    push("upstream is down");
    finish();

    const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchReturning(response)));

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe("upstream is down");
  });
});
