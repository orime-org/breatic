// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Read a whole response body, giving up if it takes too long or grows too big.
 *
 * `httpRequest` deliberately does not read bodies: how long one may take and
 * how large it may get are the caller's, and its own deadline is spent by the
 * time it hands the response back. So every caller that reads one needs this,
 * and having it in one place is what keeps the two limits from drifting apart
 * between them.
 *
 * `pipeTo` is the read that takes a signal. Cancelling underneath `text()` is
 * not open to us: the reader it holds locks the stream, and `body.cancel()`
 * then answers "Invalid state: ReadableStream is locked" while the read runs
 * on. On expiry the source is cancelled and the socket released — measured,
 * the server sees the connection close.
 *
 * The time limit is needed on its own: the platform's body timeout measures
 * inactivity, so a sender that keeps writing never trips it. Measured against
 * a real server — a body dripped one character per 300ms ran 20776ms against a
 * 500ms budget, and it scales with however long the far side keeps writing.
 */

/**
 * An answer that arrived carrying nothing.
 *
 * Named rather than left as a plain `TypeError`, because callers have to tell
 * it apart from the other one this read throws: a connection dropped mid-body
 * surfaces as `TypeError: terminated` (measured against a real server), and
 * that is a download to retry rather than an answer that was not there.
 */
export class EmptyBody extends TypeError {
  /**
   * @param message - What was missing.
   */
  constructor(message: string) {
    super(message);
    this.name = "EmptyBody";
  }
}

/** What a read was held to when it gave up. */
export class BodyTooLarge extends Error {
  /** How many bytes had arrived. */
  readonly received: number;
  /** The ceiling it was measured against. */
  readonly limit: number;

  /**
   * Build one.
   * @param received - How many bytes had arrived.
   * @param limit - The ceiling.
   */
  constructor(received: number, limit: number) {
    super(`body passed the ${limit} byte limit`);
    this.name = "BodyTooLarge";
    this.received = received;
    this.limit = limit;
  }
}

/**
 * Read a whole body as bytes, under a time budget and an optional size limit.
 *
 * The signal is the limit that does not expire on its own. A budget ends the
 * read eventually — for a twenty megabyte file at the rate this build expects,
 * five minutes later — so a caller that has gone needs its own way to say so,
 * or the bytes keep arriving for nobody.
 * @param res - The response whose body is being read.
 * @param budgetMs - How long the whole body may take to arrive.
 * @param maxBytes - The most that may arrive, when the caller has a ceiling.
 * @param signal - The caller's own signal, when it has one.
 * @returns The bytes.
 * @throws {EmptyBody} when the response carried no body, or held none.
 * @throws {BodyTooLarge} when more than `maxBytes` arrived.
 * @throws {Error} when the budget ran out, or the caller gave up.
 */
export async function readBytesWithin(
  res: Response,
  budgetMs: number,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const body = res.body;
  // A 200 with no body and one whose body is empty are the same fact: the
  // service answered and the answer was not there.
  if (body === null) throw new EmptyBody("the response carried no body");

  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;

  try {
    await body.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk, controller) {
          total += chunk.byteLength;
          if (maxBytes !== undefined && total > maxBytes) {
            // Recorded before erroring the stream: both endings arrive at the
            // catch below as a rejection, and the stream does not carry which.
            tooLarge = true;
            controller.error(new Error("over the limit"));
            return;
          }
          chunks.push(chunk);
        },
      }),
      // Truncated because a configured budget can carry a fraction (setTimeout
      // does) and `AbortSignal.timeout` answers ERR_OUT_OF_RANGE to one.
      { signal: deadline(budgetMs, signal) },
    );
  } catch (err) {
    if (tooLarge) throw new BodyTooLarge(total, maxBytes ?? total);
    throw err;
  }

  // Same fact as a null body: the service answered and the answer was not
  // there. Handing zero bytes back sends an empty payload to whatever the
  // caller does next, which for a media call is a request the model can make
  // nothing of.
  if (total === 0) throw new EmptyBody("the response body was empty");

  return join(chunks, total);
}

/**
 * The budget, and the caller's own signal when it brought one.
 * @param budgetMs - How long the read may take.
 * @param signal - The caller's signal, when it has one.
 * @returns The signal the read runs under.
 */
function deadline(budgetMs: number, signal: AbortSignal | undefined): AbortSignal {
  const budget = AbortSignal.timeout(Math.trunc(budgetMs));
  return signal === undefined ? budget : AbortSignal.any([budget, signal]);
}

/**
 * One array out of the pieces that arrived.
 *
 * Written without `Buffer`, which is a Node global this package may not reach
 * for: it is imported by the browser build, where the name is not defined.
 * @param chunks - The pieces, in order.
 * @param total - How many bytes they hold between them.
 * @returns The bytes, in one array.
 */
function join(chunks: Uint8Array[], total: number): Uint8Array {
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}

/**
 * Read a whole body as text, under a time budget.
 * @param res - The response whose body is being read.
 * @param budgetMs - How long the whole body may take to arrive.
 * @param signal - The caller's own signal, when it has one.
 * @returns The body as text.
 * @throws {EmptyBody} when the response carried no body, or it held nothing
 * but whitespace.
 * @throws {Error} when the budget ran out, or the caller gave up.
 */
export async function readWithin(
  res: Response,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readBytesWithin(res, budgetMs, undefined, signal);
  const text = new TextDecoder().decode(bytes);
  // Bytes arrived, and they say nothing. The read above already refuses a body
  // with no bytes at all; this is the same answer for one that is all spaces.
  if (text.trim() === "") throw new EmptyBody("the response body was empty");
  return text;
}
