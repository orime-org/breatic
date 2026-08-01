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
 * measured against a real socket.
 *
 * These tests drive a body that arrives in controlled chunks. A buffered
 * `new Response("...")` — what every pre-existing test in this directory
 * uses — cannot reproduce a stall at all, which is exactly why the
 * regression was invisible to a green suite.
 */

import { describe, it, expect } from "vitest";

import { httpRequest, httpRequestJson } from "@shared/http/request.js";
import { guardResponseBody, type GuardedResponse } from "@shared/http/body-guard.js";

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

/**
 * Guard one response directly, counting how often the request is torn down.
 *
 * The teardown count is the only way to see the relay's lifetime from outside:
 * an `AbortController` fires its `abort` event once no matter how many times
 * it is aborted, so a test driven through `httpRequest` cannot tell "torn down
 * once" from "torn down again by a relay that should have retired".
 * @param response - The response whose body is being policed.
 * @param callerSignal - The caller's cancellation, if the test supplies one.
 * @param idleTimeoutMs - Maximum silence between chunks.
 * @returns The handle plus a live read of the teardown count.
 */
function countingGuard(
  response: Response,
  callerSignal?: AbortSignal,
  idleTimeoutMs = 60,
): { guarded: GuardedResponse; teardowns: () => number } {
  let teardowns = 0;
  const guarded = guardResponseBody({
    response,
    idleTimeoutMs,
    ...(callerSignal !== undefined && { callerSignal }),
    abortRequest: (): void => {
      teardowns += 1;
    },
    label: "probe",
  });
  return { guarded, teardowns: (): number => teardowns };
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
    // a child process whose exit code was the verdict.
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

  it("survives cancelling a body that something else already errored", async () => {
    // The other half of the crash fix, and the half nothing was testing. The
    // test above pins the ORDER (cancel before abort); this one pins the
    // `.catch()`. They fail for different reasons and neither substitutes for
    // the other — verified by deleting each alone.
    //
    // The order fix removed our own abort as a cause of the rejection, but not
    // every cause: a peer reset can error the inner body while no pull is
    // outstanding, which is a real window in the asset download's backpressure.
    // Cancelling an already-errored stream still rejects, and an unhandled one
    // kills the process.
    const rejections: unknown[] = [];
    const capture = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", capture);

    try {
      let errorBody: (() => void) | undefined;
      const fetchImpl = ((): Promise<Response> => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            errorBody = (): void => {
              controller.error(new Error("socket reset by peer"));
            };
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }) as unknown as typeof fetch;

      const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchImpl, 5_000));
      const guarded = res.stream();
      const reader = guarded.getReader();

      // Deliberately do NOT read. One chunk is already queued, so the stream
      // is at its high-water mark and no pull is outstanding — the same
      // backpressure window the asset download sits in while its write side
      // catches up. Reading here would start another pull, and the peer's
      // error would then surface through THAT pull and error the outer stream;
      // cancelling an already-errored outer stream rejects without ever
      // reaching the source's cancel, so the catch under test would not run.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The peer dies while nobody is pulling.
      errorBody?.();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Only now does the consumer give up. Cancelling an errored stream
      // rejects; unhandled, that is a dead process.
      await reader.cancel(new Error("consumer stopped")).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", capture);
    }
  });

  it("cancels the source before tearing the request down, so it closes gracefully", async () => {
    // The third pin on the crash fix, and the one that took two attempts to
    // get right. `.catch()` and the cancel-then-abort order are each enough on
    // their own to prevent the crash, so no test that only asks "did it die"
    // can tell them apart — deleting the order alone stays green. The order
    // has a different observable consequence: cancelling first lets the
    // source's own cancel algorithm run, which is how a body closes cleanly.
    // Abort first and the source is errored, so per spec `cancel()` rejects
    // immediately WITHOUT invoking that algorithm — the connection is ripped
    // out instead of released.
    let sourceCancelled: unknown = "never called";
    const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
          // A real body errors when its request is aborted. Without this the
          // teardown has no effect on the source and the ordering becomes
          // unobservable — which is exactly why an earlier version of this
          // test stayed green against the wrong order.
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("This operation was aborted", "AbortError"));
          });
        },
        cancel(reason) {
          sourceCancelled = reason;
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as unknown as typeof fetch;

    const res = await httpRequest(URL_UNDER_TEST, {}, opts(fetchImpl, 5_000));
    const reader = res.stream().getReader();
    await reader.read();
    await reader.cancel(new Error("consumer stopped"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sourceCancelled).not.toBe("never called");
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

  it("keeps forwarding a cancellation once stream() is handed out but idle", async () => {
    // The sibling of the test above, and the hole it left. That one covers
    // "handle taken, no read method called". This one covers "stream() called,
    // no pull outstanding" — which `claim()` used to end coverage for, because
    // it retired the pre-read listener the moment ANY read method was invoked.
    // For text()/json()/arrayBuffer() that handover is instant: they start
    // draining immediately and `readChunk` takes over within the same tick.
    // `stream()` is lazy — it hands back a stream and the next pull arrives
    // whenever the consumer gets round to it, or never. Measured before the
    // fix: the abort never reached the request at all.
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

    const res = await httpRequest(URL_UNDER_TEST, {}, {
      ...opts(fetchImpl, 5_000),
      signal: controller.signal,
    });
    res.stream();
    // Let the stream's own initial pull fill its queue (high-water mark 1) and
    // then fall quiet. That quiet gap is exactly the backpressure window the
    // worker's download sits in whenever the disk is slower than the network.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(aborted).toBe(false);

    controller.abort(new Error("user pressed stop"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(aborted).toBe(true);
  });

  it("keeps forwarding a cancellation between two pulls of a stream", async () => {
    // The same hole reached the other way. One chunk is consumed, the consumer
    // pauses, and the cancellation lands while no read is in flight. Both entry
    // points matter: the invariant is "for as long as the request is live", not
    // "at the two moments we happened to test".
    let aborted = false;
    const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
          controller.enqueue(new TextEncoder().encode("second"));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as unknown as typeof fetch;
    const controller = new AbortController();

    const res = await httpRequest(URL_UNDER_TEST, {}, {
      ...opts(fetchImpl, 5_000),
      signal: controller.signal,
    });
    const reader = res.stream().getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(aborted).toBe(false);

    controller.abort(new Error("user pressed stop"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(aborted).toBe(true);
  });

  it("tears the request down when the caller cancelled before the handle existed", () => {
    // A race the transport can lose whenever a response resolves in the same
    // tick as a stop: the fetch has already produced a response, so nothing
    // rejects, and the handle is built around a signal that is ALREADY
    // aborted. A listener registered on it will never fire — `abort` was
    // dispatched before we were watching — so unless the teardown happens
    // here, the request stays live with nobody left to end it.
    const controller = new AbortController();
    controller.abort(new Error("user pressed stop"));
    const { response } = streamingBody();

    const { teardowns } = countingGuard(response, controller.signal);

    expect(teardowns()).toBe(1);
  });

  it("retires the relay when a stream pull fails, not only when it finishes", async () => {
    // `drain()` retires in a `finally`, so text()/json()/arrayBuffer() hand the
    // relay back however they end. `stream()` retired only on the `done`
    // branch, and a failing pull never reaches it: per the streams spec a
    // rejected `pull()` ERRORS the stream rather than running its cancel
    // algorithm, so that path had no other exit either. The relay then outlived
    // the body it was relaying for — still holding a listener on the caller's
    // signal, still able to tear down a request that had already ended.
    const { response } = streamingBody(); // Nothing is ever pushed: it stalls.
    const controller = new AbortController();
    const { guarded, teardowns } = countingGuard(response, controller.signal, 40);

    const reader = guarded.stream().getReader();
    await expect(reader.read()).rejects.toThrow(/idle/i);
    expect(teardowns()).toBe(1);

    controller.abort(new Error("user pressed stop"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(teardowns()).toBe(1);
  });

  it("refuses a body that outgrows the caller's byte cap, before buffering it", async () => {
    // The agent's fetch tool is handed its URL by the model, so the size of
    // the answer belongs to whoever owns that host. Its own character limit
    // runs on a string that is already in memory, which is no defence at all.
    const { response, push } = streamingBody();
    push("x".repeat(40));
    push("x".repeat(40));

    const res = await httpRequest(URL_UNDER_TEST, {}, {
      ...opts(fetchReturning(response), 5_000),
      maxBodyBytes: 50,
    });

    await expect(res.text()).rejects.toThrow(/exceeded 50 bytes/);
  });

  it("caps the streamed body too, not only the buffered reads", async () => {
    // The cap describes the response, not the read method the caller picked.
    // Enforcing it on one path only would mean `stream()` is the way around it.
    const { response, push } = streamingBody();
    push("x".repeat(40));
    push("x".repeat(40));

    const res = await httpRequest(URL_UNDER_TEST, {}, {
      ...opts(fetchReturning(response), 5_000),
      maxBodyBytes: 50,
    });
    const reader = res.stream().getReader();

    expect((await reader.read()).value).toHaveLength(40);
    await expect(reader.read()).rejects.toThrow(/exceeded 50 bytes/);
  });

  it("lets a body that fits through untouched", async () => {
    const { response, push, finish } = streamingBody();
    push("under the cap");
    finish();

    const res = await httpRequest(URL_UNDER_TEST, {}, {
      ...opts(fetchReturning(response), 5_000),
      maxBodyBytes: 50,
    });

    expect(await res.text()).toBe("under the cap");
  });

  it("names the shape when a vendor answers JSON that is not an object", async () => {
    // `httpRequestJson` promised its callers a record and cast an unchecked
    // `unknown` into one. A vendor answering `null` or a list still satisfied
    // the compiler and then failed inside a provider transport, far from the
    // request that caused it.
    const { response, push, finish } = streamingBody();
    push("[1,2,3]");
    finish();

    await expect(
      httpRequestJson(URL_UNDER_TEST, {}, opts(fetchReturning(response), 5_000)),
    ).rejects.toThrow(/expected a JSON object.*got an array/);
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
