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
 * consumes the body, so exactly one of them may be called — same rule as
 * the platform's own `Response`.
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
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        ctx.abortRequest();
        reject(
          new Error(
            `${label} response body stalled: no data for ${idleTimeoutMs}ms (idle timeout)`,
          ),
        );
      }, idleTimeoutMs);
    });

    const cancellation = new Promise<never>((_resolve, reject) => {
      if (callerSignal === undefined) return;
      onAbort = (): void => {
        ctx.abortRequest();
        reject(abortErrorOf(callerSignal, label));
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
 * @param ctx - The response, deadline, cancellation and teardown hook.
 * @returns A handle exposing the metadata callers use and guarded reads.
 */
export function guardResponseBody(ctx: BodyGuardContext): GuardedResponse {
  const { response } = ctx;

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,

    async text(): Promise<string> {
      return new TextDecoder().decode(concat(await drain(ctx)));
    },

    async json(): Promise<unknown> {
      const raw = new TextDecoder().decode(concat(await drain(ctx)));
      return JSON.parse(raw);
    },

    async arrayBuffer(): Promise<ArrayBuffer> {
      const joined = concat(await drain(ctx));
      // Allocate and copy rather than slicing the view's own `buffer`. That
      // property is typed `ArrayBuffer | SharedArrayBuffer`, so slicing it
      // yields a union no `ArrayBuffer` consumer accepts — and whether the
      // surrounding tsconfig happens to complain varies by package, which is
      // how a cast here passed one checker while failing another. Allocating
      // the exact size is unambiguous, and it also guarantees the caller gets
      // a buffer sized to the bytes rather than to a larger allocation.
      const out = new ArrayBuffer(joined.byteLength);
      new Uint8Array(out).set(joined);
      return out;
    },

    stream(): ReadableStream<Uint8Array> {
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
          // Each pull is deadline-guarded, so the protection travels with
          // the stream rather than stopping at this function's boundary.
          const { done, value } = await readChunk(reader, ctx);
          if (done) {
            controller.close();
            reader.releaseLock();
            return;
          }
          if (value !== undefined) controller.enqueue(value);
        },
        cancel(reason): void {
          ctx.abortRequest();
          void reader.cancel(reason);
        },
      });
    },
  };
}
