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
 * @param res - The response whose body is being read.
 * @param budgetMs - How long the whole body may take to arrive.
 * @param maxBytes - The most that may arrive, when the caller has a ceiling.
 * @returns The bytes.
 * @throws {TypeError} when the response carried no body.
 * @throws {BodyTooLarge} when more than `maxBytes` arrived.
 * @throws {Error} when the budget ran out before the body finished.
 */
export async function readBytesWithin(
  res: Response,
  budgetMs: number,
  maxBytes?: number,
): Promise<Uint8Array> {
  const body = res.body;
  // A 200 with no body and one whose body is empty are the same fact: the
  // service answered and the answer was not there.
  if (body === null) throw new TypeError("the response carried no body");

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
      { signal: AbortSignal.timeout(Math.trunc(budgetMs)) },
    );
  } catch (err) {
    if (tooLarge) throw new BodyTooLarge(total, maxBytes ?? total);
    throw err;
  }

  return Buffer.concat(chunks, total);
}

/**
 * Read a whole body as text, under a time budget.
 * @param res - The response whose body is being read.
 * @param budgetMs - How long the whole body may take to arrive.
 * @returns The body as text.
 * @throws {TypeError} when the response carried no body, or the body was empty.
 * @throws {Error} when the budget ran out before the body finished.
 */
export async function readWithin(res: Response, budgetMs: number): Promise<string> {
  const bytes = await readBytesWithin(res, budgetMs);
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") throw new TypeError("the response body was empty");
  return text;
}
