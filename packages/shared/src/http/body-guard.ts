// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Reading a response body under its own idle deadline.
 *
 * "Wait for headers" and "read the body" are two different waits and need
 * two different deadlines. Every mature client splits them — Go pairs
 * `Transport.ResponseHeaderTimeout` with `Client.Timeout`, undici pairs
 * `headersTimeout` with `bodyTimeout`, python-requests pairs connect with
 * read — and this module is the second half of that pair.
 *
 * The deadline is IDLE, not total: it measures the gap between chunks. A
 * 500 MB asset that takes four minutes to arrive is not a failure, while a
 * connection that flushed headers and then went silent is. A total deadline
 * cannot express both, which is why it was rejected for this layer
 * (decided 2026-07-30).
 *
 * The guarded handle deliberately does NOT expose the underlying
 * `Response`. Handing one out is what let the deadline be bypassed before:
 * whoever holds a raw response can read its body with no deadline at all,
 * and eight call sites did exactly that. Callers get the metadata they
 * actually use plus read methods that cannot escape the deadline.
 */

/**
 * A response whose body can only be read under an idle deadline.
 *
 * Mirrors the small part of `Response` the callers use. Each read method
 * consumes the body, so exactly one of them may be called — same rule as the
 * platform's own `Response`, and enforced the same way: a second read throws.
 *
 * There is no "discard without reading" member, and that is deliberate — but
 * the tradeoff is real and worth stating plainly rather than claiming the
 * problem away. A caller that takes a handle and neither reads nor cancels it
 * holds the connection until the peer times out, the same as holding an unread
 * `Response`. Six call sites do exactly that with a FINAL non-ok response:
 * they throw or return without touching the body. That is unchanged from
 * before this transport existed, and measured, it only pins a socket for
 * bodies past roughly 8 MB — below that the client buffers and returns the
 * connection to the pool either way. Of the six, only the agent's fetch tool
 * can be handed a body that large, because only it takes an arbitrary URL from
 * a conversation.
 *
 * A release method was considered and rejected: every plausible implementation
 * aborts the request, and callers would reach for it in `finally` blocks that
 * also run on the success path, tearing down transfers that were fine. What
 * the transport does close is the other leak — it now tears down the attempts
 * it retries PAST, which no caller could ever have reached.
 */
export interface GuardedResponse {
  /** Whether the status is in the 2xx range. */
  readonly ok: boolean;
  /** HTTP status code. */
  readonly status: number;
  /** Response headers. */
  readonly headers: Headers;
  /**
   * Read the whole body as text.
   * @returns The decoded body.
   * @throws {Error} On an idle-deadline breach or the caller's cancellation.
   */
  text(): Promise<string>;
  /**
   * Read the whole body and parse it as JSON.
   * @returns The parsed value.
   * @throws {Error} On an idle-deadline breach, the caller's cancellation,
   *   or an unparseable body.
   */
  json(): Promise<unknown>;
  /**
   * Read the whole body as bytes. Used by the audio vendors.
   * @returns The raw bytes.
   * @throws {Error} On an idle-deadline breach or the caller's cancellation.
   */
  arrayBuffer(): Promise<ArrayBuffer>;
  /**
   * Expose the body as a stream that carries the deadline with it, for
   * payloads too large to buffer (asset downloads write straight to disk).
   * @returns A stream whose every pull is deadline-guarded.
   */
  stream(): ReadableStream<Uint8Array>;
}

/** What the guard needs in order to police one body. */
export interface BodyGuardContext {
  /** The response whose body is being policed. */
  response: Response;
  /** Maximum silence between chunks, in milliseconds. */
  idleTimeoutMs: number;
  /** The caller's cancellation, if any. */
  callerSignal?: AbortSignal;
  /**
   * Tear down the underlying request. Called when the deadline is breached,
   * because dropping the reader alone can leave the connection held open —
   * aborting the request is what actually releases it.
   */
  abortRequest: () => void;
  /** Provider or tool name, for error messages. */
  label: string;
}

/**
 * Turn an abort signal's reason into a throwable error.
 * @param signal - The signal that was aborted.
 * @param label - Provider or tool name, for the fallback message.
 * @returns The caller's own error when it supplied one, else a generic one.
 */
function abortErrorOf(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${label} response body read cancelled by caller`);
}

/**
 * Read one chunk, failing if the wait exceeds the idle deadline or the
 * caller cancels.
 *
 * The deadline is armed per chunk rather than once for the whole body —
 * that is the difference between "no data for N ms" and "took longer than
 * N ms in total", and only the former lets a slow-but-alive transfer
 * finish.
 * @param reader - Reader over the source body.
 * @param ctx - The guard's context.
 * @returns The chunk, or a done marker at the end of the body.
 * @throws {Error} On an idle-deadline breach or the caller's cancellation.
 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ctx: BodyGuardContext,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const { callerSignal, idleTimeoutMs, label } = ctx;

  if (callerSignal?.aborted === true) {
    ctx.abortRequest();
    throw abortErrorOf(callerSignal, label);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    // Reject BEFORE tearing the request down, in both branches. Aborting a
    // real request makes its body stream error out, and that rejection lands
    // in the microtask queue too — abort first and it can win the race below,
    // surfacing a bare "This operation was aborted" instead of the reason.
    // The caller has to be able to tell an idle body apart from its own
    // cancellation, so which error wins cannot be left to ordering luck.
    // Measured against a real socket; a hand-built stream in a unit test
    // ignores the abort entirely and never exposes this.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `${label} response body stalled: no data for ${idleTimeoutMs}ms (idle timeout)`,
          ),
        );
        ctx.abortRequest();
      }, idleTimeoutMs);
    });

    const cancellation = new Promise<never>((_resolve, reject) => {
      if (callerSignal === undefined) return;
      onAbort = (): void => {
        reject(abortErrorOf(callerSignal, label));
        ctx.abortRequest();
      };
      callerSignal.addEventListener("abort", onAbort, { once: true });
    });

    return await Promise.race([reader.read(), deadline, cancellation]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) ctx.callerSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Drain the whole body under the deadline.
 * @param ctx - The guard's context.
 * @returns Every chunk, in order.
 * @throws {Error} On an idle-deadline breach or the caller's cancellation.
 */
async function drain(ctx: BodyGuardContext): Promise<Uint8Array[]> {
  const body = ctx.response.body;
  if (body === null) return [];

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, ctx);
      if (done) return chunks;
      if (value !== undefined) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Concatenate chunks into one buffer.
 * @param chunks - The chunks to join.
 * @returns A single contiguous buffer.
 */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Wrap a response so its body can only be read under an idle deadline.
 *
 * The handle takes ownership of the request. Two obligations come with that,
 * both learned by getting them wrong:
 *
 * A cancellation has to reach the live request for as long as the request is
 * live — not merely while a read happens to be in flight. The transport's
 * per-attempt listener retires when the headers land, and `readChunk` listens
 * only for the duration of one pending read, so between "handle returned" and
 * "first read issued" nothing was watching: pressing stop left the server
 * streaming to nobody. That window is covered here rather than by asking every
 * caller to read immediately, an invariant invisible at the call site.
 *
 * The body is a one-shot resource, so a second read is refused instead of
 * being answered with nothing. The platform's own `Response` throws; returning
 * an empty string would turn a caller's mistake into a plausible value.
 * @param ctx - The response, deadline, cancellation and teardown hook.
 * @returns A handle exposing the metadata callers use and guarded reads.
 */
export function guardResponseBody(ctx: BodyGuardContext): GuardedResponse {
  const { response } = ctx;

  let claimed = false;

  /**
   * Forward a cancellation that arrives before any read has started.
   *
   * Deliberately narrow: once a read owns the body, `readChunk` handles
   * cancellation itself, and it must reject with the caller's reason BEFORE
   * aborting — the abort errors the source stream, and that error would
   * otherwise win the race and mask the reason. A listener that stayed armed
   * here would preempt exactly that ordering, so `claim` retires it.
   */
  const onCallerAbort = (): void => {
    ctx.abortRequest();
  };
  ctx.callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  /** Retire the pre-read cancellation listener. */
  const settle = (): void => {
    ctx.callerSignal?.removeEventListener("abort", onCallerAbort);
  };

  /**
   * Take ownership of the body for one read.
   * @param method - The read method being invoked, for the message.
   * @throws {Error} When another read already consumed the body.
   */
  const claim = (method: string): void => {
    if (claimed) {
      throw new Error(
        `${ctx.label} response body was already consumed; ${method}() cannot read it again`,
      );
    }
    claimed = true;
    settle();
  };

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,

    async text(): Promise<string> {
      claim("text");
      return new TextDecoder().decode(concat(await drain(ctx)));
    },

    async json(): Promise<unknown> {
      claim("json");
      return JSON.parse(new TextDecoder().decode(concat(await drain(ctx))));
    },

    async arrayBuffer(): Promise<ArrayBuffer> {
      claim("arrayBuffer");
      const joined = concat(await drain(ctx));
      // Allocate and copy rather than slicing the view's own `buffer`. That
      // property is typed `ArrayBuffer | SharedArrayBuffer`, so slicing it
      // yields a union no `ArrayBuffer` consumer accepts — and whether the
      // surrounding tsconfig complains varies by package, which is how a cast
      // here passed one checker while failing another. Allocating the exact
      // size is unambiguous, and hands back a buffer sized to the bytes rather
      // than to a possibly larger allocation.
      const out = new ArrayBuffer(joined.byteLength);
      new Uint8Array(out).set(joined);
      return out;
    },

    stream(): ReadableStream<Uint8Array> {
      claim("stream");
      const body = response.body;
      if (body === null) {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      }
      const reader = body.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          // Each pull is deadline-guarded, so the protection travels with the
          // stream rather than stopping at this function's boundary.
          const { done, value } = await readChunk(reader, ctx);
          if (done) {
            controller.close();
            reader.releaseLock();
            return;
          }
          if (value !== undefined) controller.enqueue(value);
        },
        cancel(reason): void {
          // Teardown runs LAST here, same as in readChunk — cancel first,
          // then abort. That ordering is load-bearing: aborting first errors
          // the inner body, and the spec then has `cancel()` return a promise
          // rejected with the stored error without running the underlying
          // cancel algorithm. An earlier version aborted first and left that
          // rejection floating, which Node terminates the process for.
          //
          // The `.catch()` is NOT redundant now that the order is right. Our
          // own abort can no longer cause the rejection, but something else
          // can: the peer or upstream may have errored the inner body already
          // — in `downloadToTempDir` there is a backpressure window where no
          // pull is outstanding and a reset lands there. Cancelling a body
          // that is already errored still rejects, and only collab installs an
          // unhandled-rejection net, so without this the worker dies with
          // every job in flight.
          //
          // Measured both halves: `engineering/demo/2026-07-30-stream-cancel-crash-repro.ts`
          // for the ordering, and the "already errored before cancel" test
          // below for this catch. Deleting either one alone still crashes.
          void reader
            .cancel(reason)
            .catch(() => {
              // Already errored or released: nothing left to release, and the
              // consumer's own failure is the one that counts.
            })
            .finally(() => {
              ctx.abortRequest();
            });
        },
      });
    },
  };
}
