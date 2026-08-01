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
 * and twelve reads across eight files did exactly that (counted on the
 * commit this replaced, not remembered). Callers get the metadata they
 * actually use plus read methods that cannot escape the deadline.
 */

/**
 * A response whose body can only be read under an idle deadline.
 *
 * Mirrors the small part of `Response` the callers use. Each read method
 * consumes the body, so exactly one of them may be called — same rule as the
 * platform's own `Response`, and enforced the same way: a second read throws.
 *
 * There is no "discard without reading" member, and the tradeoff that comes
 * with that is real. A caller who takes a handle and neither reads nor cancels
 * it holds the connection, the same as holding an unread `Response`. Six call
 * sites do exactly that with a FINAL non-ok response — they throw or return
 * without touching the body: the two asset downloads, Topaz's cost estimate,
 * the agent's fetch and search tools, and the browser upload. That behaviour
 * is unchanged from before this transport existed.
 *
 * Measured against a real socket: a body
 * of 64 KiB or more stops the socket being reused, and anything smaller is
 * buffered and the connection returns to the pool. 64 KiB is the client's
 * stream high-water mark, not a size anyone chose. An earlier version of this
 * comment claimed the bound was "roughly 8 MB" and called it measured; it was
 * neither measured nor right, and the conclusion drawn from it — that only the
 * agent's fetch tool could be handed a body that large — did not survive the
 * real number.
 *
 * A release method was considered and not added: every implementation of one
 * aborts the request, and callers reach for such things in `finally` blocks
 * that also run on the success path, tearing down transfers that were fine.
 * That is a judgement about how the method would be used, not a proof that it
 * cannot be built. What the transport does close is the other leak — it tears
 * down the attempts it retries PAST, which no caller could ever reach.
 */
export interface GuardedResponse {
  /** Whether the status is in the 2xx range. */
  readonly ok: boolean;
  /** HTTP status code. */
  readonly status: number;
  /** Response headers. */
  readonly headers: Headers;
  /**
   * The wait this response asked for, in milliseconds, or null when it named
   * none or named one that cannot be read.
   *
   * Parsed here rather than left to each caller because the transport has
   * already parsed it to make its own decision, and two parsers of the same
   * header are two chances to disagree. It is the response's own statement,
   * not a retry verdict: it is present whether or not anything was retried.
   */
  readonly retryAfterMs: number | null;
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
   *
   * One obligation comes back to the consumer, and it is easy to get wrong:
   * CATCH the promise from `cancel()`. Per the streams spec, cancelling a
   * stream that has already errored returns a promise rejected with the
   * stored error, and an uncaught rejection terminates a Node process — so
   * the textbook `finally { void reader.cancel() }` is a crash waiting for a
   * stalled body. Measured on both this stream and a plain one
   * against a real socket: the
   * behaviour is the platform's, identical either way, so nothing here can
   * fix it for the caller.
   *
   * It is spelled out because THIS stream errors far more readily than most:
   * it fails on its own the moment a body goes quiet past the idle deadline,
   * which is precisely when a consumer is winding down and reaching for
   * `cancel()`. `pipeline()` handles this correctly and is what the one
   * consumer in the repo uses; hand-rolled reader loops must not skip it.
   * @returns A stream whose every pull is deadline-guarded.
   * @throws {Error} SYNCHRONOUSLY, when another read already consumed the
   *   body — unlike its siblings, which are async and reject. It is the only
   *   member with that shape, and the only one whose `@throws` was missing.
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
   * Largest body this caller will accept, in bytes. Unbounded when absent.
   *
   * A parameter rather than a fixed number because the acceptable size varies
   * by orders of magnitude between callers on this same transport: a vendor's
   * JSON reply is kilobytes, a generated video is hundreds of megabytes, and
   * one figure cannot serve both.
   *
   * It exists because ONE caller does not choose its own URL. The agent's
   * fetch tool is handed a URL by the model, so whoever owns that host
   * decides how many bytes arrive — and the tool's own character limit is
   * applied to a string that is already in memory by then.
   */
  maxBytes?: number;
  /**
   * Tear down the underlying request. Called when the deadline is breached,
   * because dropping the reader alone can leave the connection held open —
   * aborting the request is what actually releases it.
   */
  abortRequest: () => void;
  /** Provider or tool name, for error messages. */
  label: string;
  /** The wait this response asked for, already parsed. */
  retryAfterMs: number | null;
  /**
   * Which request this body belongs to, ALREADY REDACTED.
   *
   * Every failure this module reports used to name only the label — "probe
   * response body stalled" — which tells an on-call engineer the provider and
   * nothing else. A vendor with twenty endpoints produced twenty identical
   * messages. Redaction happens at the caller because some vendors put their
   * key in the query string, and an error that carries one is a credential
   * waiting for any future log to write it down.
   */
  url: string;
}

/**
 * Turn an abort signal's reason into a throwable error.
 * @param signal - The signal that was aborted.
 * @param ctx - The guard's context, for the fallback message.
 * @returns The caller's own error when it supplied one, else a generic one.
 */
function abortErrorOf(signal: AbortSignal, ctx: BodyGuardContext): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${ctx.label} body read of ${ctx.url} cancelled by caller`);
}

/**
 * The single place a caller's cancellation is turned into an outcome.
 *
 * There used to be two: one armed while no read had started, one armed for
 * the duration of each read, handing off to each other. Every handoff is a
 * seam, and `stream()` opened one wide — it returns a lazy stream, so the
 * gap between "read method called" and "a read is actually in flight" can be
 * arbitrarily long, or never close at all. Measured: pressing stop in that
 * gap reached nothing. One relay, armed from the moment the handle exists
 * until the body is finished, has no handoff to get wrong.
 */
interface CancellationRelay {
  /** The cancellation that already landed, or null while none has. */
  readonly error: () => Error | null;
  /**
   * Arm a rejection for the duration of one read.
   * @returns The promise to race, and the disposer that unregisters it.
   */
  wait: () => { promise: Promise<never>; dispose: () => void };
  /** Stop relaying — the body is finished and nothing is left to cancel. */
  retire: () => void;
}

/**
 * Build the relay and arm it on the caller's signal.
 * @param ctx - The guard's context.
 * @returns A relay that survives for as long as the request does.
 */
function armCancellation(ctx: BodyGuardContext): CancellationRelay {
  const { callerSignal } = ctx;
  let landed: Error | null =
    callerSignal?.aborted === true ? abortErrorOf(callerSignal, ctx) : null;
  const waiting = new Set<(error: Error) => void>();

  /** Turn the caller's cancellation into an outcome for whoever is waiting. */
  const onAbort = (): void => {
    if (callerSignal === undefined) return;
    landed = abortErrorOf(callerSignal, ctx);
    // Reject the pending reads BEFORE tearing the request down. Aborting a
    // real request errors its body stream, and that rejection lands in the
    // microtask queue too — abort first and it can win the race, surfacing a
    // bare "This operation was aborted" instead of the caller's own reason.
    // Which error wins cannot be left to ordering luck, because the caller
    // has to tell an idle body apart from its own cancellation. Measured
    // against a real socket; a hand-built stream ignores the abort entirely
    // and never exposes this.
    for (const reject of waiting) reject(landed);
    waiting.clear();
    ctx.abortRequest();
  };

  if (landed !== null) {
    // The caller cancelled before this handle existed — a race the transport
    // loses whenever a response resolves in the same tick as a stop. Nothing
    // will fire later: `abort` was dispatched before we were watching, and a
    // listener added now never runs. Tear the request down here or it stays
    // live with nobody left to end it.
    ctx.abortRequest();
  } else {
    callerSignal?.addEventListener("abort", onAbort, { once: true });
  }

  return {
    error: (): Error | null => landed,
    wait: (): { promise: Promise<never>; dispose: () => void } => {
      let reject!: (error: Error) => void;
      const promise = new Promise<never>((_resolve, rejectFn) => {
        reject = rejectFn;
      });
      waiting.add(reject);
      return { promise, dispose: (): boolean => waiting.delete(reject) };
    },
    retire: (): void => {
      waiting.clear();
      callerSignal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Count a body's bytes against the caller's cap.
 *
 * Enforced as chunks arrive rather than on the finished buffer, which is the
 * whole point: a cap checked afterwards has already paid for the memory it
 * was meant to refuse. It applies to `stream()` as well as the buffered
 * reads — the cap describes the response, not the method the caller picked.
 * @param ctx - The guard's context, for the cap and the label.
 * @returns A meter to feed every chunk; a no-op when no cap was set.
 */
function meterBytes(ctx: BodyGuardContext): (chunk: Uint8Array) => void {
  const { maxBytes } = ctx;
  if (maxBytes === undefined) return (): void => {};
  let seen = 0;
  return (chunk: Uint8Array): void => {
    seen += chunk.byteLength;
    if (seen > maxBytes) {
      throw new Error(
        `${ctx.label} body of ${ctx.url} exceeded ${maxBytes} bytes and was refused`,
      );
    }
  };
}

/**
 * Read one chunk, failing if the wait exceeds the idle deadline, the caller
 * cancels, or the body outgrows its cap.
 *
 * The deadline is armed per chunk rather than once for the whole body —
 * that is the difference between "no data for N ms" and "took longer than
 * N ms in total", and only the former lets a slow-but-alive transfer
 * finish.
 * @param reader - Reader over the source body.
 * @param ctx - The guard's context.
 * @param relay - The guard's single cancellation relay.
 * @param spend - The guard's byte meter, fed every chunk that arrives.
 * @returns The chunk, or a done marker at the end of the body.
 * @throws {Error} On an idle-deadline breach, the caller's cancellation, or a
 *   body that outgrew its cap.
 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ctx: BodyGuardContext,
  relay: CancellationRelay,
  spend: (chunk: Uint8Array) => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const { idleTimeoutMs } = ctx;

  const already = relay.error();
  if (already !== null) {
    ctx.abortRequest();
    throw already;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiter = relay.wait();

  try {
    // Same ordering rule as the relay's, for the same reason: reject first,
    // tear down second.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `${ctx.label} body of ${ctx.url} stalled: no data for ${idleTimeoutMs}ms (idle timeout)`,
          ),
        );
        ctx.abortRequest();
      }, idleTimeoutMs);
    });

    const result = await Promise.race([reader.read(), deadline, waiter.promise]);
    if (result.value !== undefined) {
      try {
        spend(result.value);
      } catch (error) {
        // Same ordering rule again: decide the failure first, tear the
        // request down second, so the cap is what the caller sees rather
        // than the abort it triggers.
        ctx.abortRequest();
        throw error;
      }
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    waiter.dispose();
  }
}

/**
 * Drain the whole body under the deadline.
 * @param ctx - The guard's context.
 * @param relay - The guard's single cancellation relay.
 * @param spend - The guard's byte meter, fed every chunk that arrives.
 * @returns Every chunk, in order.
 * @throws {Error} On an idle-deadline breach, the caller's cancellation, or a
 *   body that outgrew its cap.
 */
async function drain(
  ctx: BodyGuardContext,
  relay: CancellationRelay,
  spend: (chunk: Uint8Array) => void,
): Promise<Uint8Array[]> {
  const body = ctx.response.body;
  if (body === null) {
    // A cancellation that already landed outranks the absence of a body.
    // Returning "no chunks" here made `text()` resolve to "" for a request the
    // caller had already stopped — a plausible value, and indistinguishable
    // from a response that genuinely carried nothing.
    const already = relay.error();
    relay.retire();
    if (already !== null) {
      ctx.abortRequest();
      throw already;
    }
    return [];
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, ctx, relay, spend);
      if (done) return chunks;
      if (value !== undefined) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    relay.retire();
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
 * live — not merely while a read happens to be in flight. That is what
 * `armCancellation` is for, and the reason it is ONE relay rather than a
 * listener per phase: an earlier cut had a pre-read listener that `claim()`
 * retired plus a per-read listener inside `readChunk`, and the handoff between
 * them was a hole. `text()`/`json()`/`arrayBuffer()` hid it, because they start
 * draining in the same tick. `stream()` does not — it hands back a lazy stream
 * whose next pull arrives whenever the consumer gets to it, so the uncovered
 * gap could last as long as a slow disk cared to make it. Measured on the real
 * transport: a stop pressed in that gap reached nothing at all. The window is
 * covered here rather than by asking every caller to read immediately, an
 * invariant invisible at the call site.
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
  const relay = armCancellation(ctx);
  const spend = meterBytes(ctx);

  /**
   * Take ownership of the body for one read.
   * @param method - The read method being invoked, for the message.
   * @throws {Error} When another read already consumed the body.
   */
  const claim = (method: string): void => {
    if (claimed) {
      throw new Error(
        `${ctx.label} body of ${ctx.url} was already consumed; ${method}() cannot read it again`,
      );
    }
    claimed = true;
  };

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    retryAfterMs: ctx.retryAfterMs,

    async text(): Promise<string> {
      claim("text");
      return new TextDecoder().decode(concat(await drain(ctx, relay, spend)));
    },

    async json(): Promise<unknown> {
      claim("json");
      const text = new TextDecoder().decode(concat(await drain(ctx, relay, spend)));
      try {
        return JSON.parse(text);
      } catch {
        // The platform's own SyntaxError says "Unexpected token < in JSON at
        // position 0" and nothing else — not which provider, not which request.
        // A vendor answering an HTML error page produced exactly that, and it
        // reached the logs with no way to trace it back. The body itself stays
        // out of the message: it can be megabytes, and it can carry a token the
        // vendor echoed.
        throw new Error(
          `${ctx.label} response from ${ctx.url} could not be parsed as JSON`,
        );
      }
    },

    async arrayBuffer(): Promise<ArrayBuffer> {
      claim("arrayBuffer");
      const joined = concat(await drain(ctx, relay, spend));
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
        // Same rule as `drain`: a stop the caller already pressed is the
        // outcome, not an empty stream that looks like a clean finish.
        const already = relay.error();
        relay.retire();
        if (already !== null) {
          ctx.abortRequest();
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(already);
            },
          });
        }
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
          // stream rather than stopping at this function's boundary. The gaps
          // BETWEEN pulls are covered too, by the relay — a consumer that
          // pauses (a slow disk, a full pipe) leaves no window in which a
          // cancellation would reach nobody.
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await readChunk(reader, ctx, relay, spend);
          } catch (error) {
            // A failed pull ends this body as surely as a finished one, and it
            // is the ONLY exit that path has: per the streams spec a rejected
            // `pull()` errors the stream instead of running its cancel
            // algorithm, so `cancel()` below never gets a chance to clean up.
            // Left out, the relay outlives the request it was relaying for —
            // still holding a listener on the caller's signal, still able to
            // tear down something that already ended. `drain()` retires in a
            // `finally` for the same reason; this is that invariant's other
            // half, which is where it went missing.
            reader.releaseLock();
            relay.retire();
            throw error;
          }
          const { done, value } = chunk;
          if (done) {
            // Release before closing, because `close()` throws on a stream the
            // consumer already cancelled and the lock has to come off either
            // way. Measured against a real socket:
            // that throw has no observable consequence — a cancel resolves the
            // pending read as done first, and the late error lands on an
            // already-closed stream. So this is ordering correctness, not a bug
            // fix, and it is recorded that way rather than dressed up as one.
            reader.releaseLock();
            relay.retire();
            controller.close();
            return;
          }
          if (value !== undefined) controller.enqueue(value);
        },
        cancel(reason): void {
          // Three things have to happen here and the ORDER is load-bearing.
          //
          // Cancel before aborting. Aborting first errors the inner body, and
          // the spec then has `cancel()` return a promise rejected with the
          // stored error without running the underlying cancel algorithm. An
          // earlier version aborted first and left that rejection floating,
          // which Node ends the process for.
          //
          // Catch the cancel. Our own abort can no longer cause that
          // rejection, but the peer can: it may have errored the inner body
          // already — `downloadToTempDir` has a backpressure window where no
          // pull is outstanding and a reset lands there. Cancelling a body
          // that is already errored still rejects.
          //
          // Catch the teardown too. It belongs to the layer above, nothing
          // awaits this chain, and a throwing one used to become an unhandled
          // rejection all the same.
          //
          // All three were measured rather than reasoned about: a child
          // process exiting non-zero pinned the ordering, and the two tests
          // below pin the catches. Removing any one alone still crashes.
          relay.retire();
          void (async (): Promise<void> => {
            try {
              await reader.cancel(reason);
            } catch {
              // Already errored or released: nothing left to release, and the
              // consumer's own failure is the one that counts.
            }
            try {
              ctx.abortRequest();
            } catch {
              // The teardown belongs to the layer above and a broken one is
              // its bug — but this chain is not awaited by anyone, so letting
              // it throw here produced an unhandled rejection and ended the
              // process. Measured in a child process: exit code 1, which is
              // the same shape that once took the worker down with every job
              // it was running.
            }
          })();
        },
      });
    },
  };
}
