// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Bounded read of a stored source ledger companion (inner#1306 consumer
 * oracle C01–C13). The real transport, body reader, WebCrypto digest and
 * strict parser all run; only the network under `fetch` is controlled, with
 * streams that stay open until read so a cancellation is observable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BodyTooLarge, EmptyBody } from '../../http/read-within.js';
import { DeadlinePassed } from '../../http/deadline.js';
import { readVideoSourceLedger, VideoSourceLedgerReadRefused } from '../read-video-source-ledger.js';
import type { VideoSourceLedgerCompanion, VideoSourceLedgerReceipt } from '../video-source-ledger-types.js';
import { ledgerFixture, receiptFor } from './helpers/video-source-ledger-fixtures.js';

const LIMITS = { maxBytes: 1_000_000, maxPhysicalFrames: 1024, maxOccurrences: 1024 };
const URL_ = 'https://assets.example.test/source.video-source-ledger.v1.json';

let clock = 1_800_000_000_000;

/**
 * Lowercase SHA-256 of the exact bytes.
 * @param bytes - The bytes.
 * @returns The hex digest.
 */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A receipt measured over these bytes.
 * @param value - The companion the receipt names.
 * @param bytes - The bytes it was measured over.
 * @returns The receipt.
 */
async function measured(value: VideoSourceLedgerCompanion, bytes: Uint8Array): Promise<VideoSourceLedgerReceipt> {
  return { ...receiptFor(value), url: URL_, size: bytes.byteLength, sha256: await sha256(bytes) };
}

/** An open stream and what happened to it. */
interface Served {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
}

/**
 * A stream that hands over its chunks only when read, then closes or hangs.
 * @param chunks - The chunks, in order.
 * @param end - Whether the stream closes after the last chunk or stays open.
 * @returns The stream and whether it was cancelled.
 */
function serve(chunks: Uint8Array[], end: 'close' | 'hang' = 'close'): Served {
  let at = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (at < chunks.length) {
          controller.enqueue(chunks[at++]);
          return undefined;
        }
        if (end === 'close') {
          controller.close();
          return undefined;
        }
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, cancelled: () => cancelled };
}

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

/**
 * Answer the next GET with this body and these headers.
 * @param served - The body.
 * @param init - Status and headers.
 */
function answer(served: Served | null, init: ResponseInit = {}): void {
  fetchMock.mockImplementationOnce(async () =>
    new Response(served?.stream ?? null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    }),
  );
}

/**
 * The companion's compact bytes.
 * @param value - The companion.
 * @returns The bytes.
 */
function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Read under a deadline one minute ahead of the controlled clock.
 * @param receipt - The receipt.
 * @param limits - The limits.
 * @param signal - The caller's signal.
 * @returns The read.
 */
function read(
  receipt: VideoSourceLedgerReceipt,
  limits: typeof LIMITS = LIMITS,
  signal?: AbortSignal,
): Promise<VideoSourceLedgerCompanion> {
  return readVideoSourceLedger(receipt, limits, { deadlineAt: clock + 60_000, ...(signal && { signal }) });
}

/**
 * Expect a refusal with this reason.
 * @param pending - The read.
 * @param reason - The reason.
 */
async function refused(pending: Promise<unknown>, reason: VideoSourceLedgerReadRefused['reason']): Promise<void> {
  const err = await pending.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VideoSourceLedgerReadRefused);
  expect((err as VideoSourceLedgerReadRefused).reason).toBe(reason);
}

beforeEach(() => {
  clock = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('C01–C02 a complete valid companion', () => {
  it('returns the whole companion with original decimal strings after EOF', async () => {
    const value = ledgerFixture('cfr.mp4');
    const huge = '9007199254740993123';
    value.physical.frames[0]!.ptsTicks = huge;
    for (const frame of value.presentation.frames) if (frame.rawDecodeOrdinal === 0) frame.sourcePtsTicks = huge;
    const bytes = bytesOf(value);
    answer(serve([bytes.subarray(0, 100), bytes.subarray(100)]));
    const got = await read(await measured(value, bytes));
    expect(got).toEqual(value);
    expect(got.physical.frames[0]!.ptsTicks).toBe(huge);
  });

  it.each(['repeated-edit', 'mid-frame-start', 'K04', 'N01'])('keeps every occurrence of %s exactly', async (id) => {
    const value = ledgerFixture(id);
    const bytes = bytesOf(value);
    answer(serve([bytes]));
    expect(await read(await measured(value, bytes))).toEqual(value);
  });

  it('accepts a legal table with zero occurrences', async () => {
    const value = ledgerFixture('cfr.mp4');
    value.presentation.frames = [];
    const bytes = bytesOf(value);
    answer(serve([bytes]));
    const receipt = await measured(value, bytes);
    expect(receipt.occurrenceCount).toBe(0);
    expect(await read(receipt)).toEqual(value);
  });

  it('accepts a receipt whose producer deadline is long past (C13)', async () => {
    const value = ledgerFixture('N02');
    value.attempt = { jobId: value.attempt.jobId, deadlineAt: 1000 };
    const bytes = bytesOf(value);
    answer(serve([bytes]));
    expect(await read(await measured(value, bytes))).toEqual(value);
  });

  it('sends a plain GET to the receipt URL with no credentials, If-Match or HEAD', async () => {
    const value = ledgerFixture('K01');
    const bytes = bytesOf(value);
    answer(serve([bytes]));
    await read(await measured(value, bytes));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(URL_);
    expect((init.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = new Headers(init.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('if-match')).toBe(false);
    expect(init.credentials).not.toBe('include');
  });
});

describe('C03 refusals before the network', () => {
  /**
   * A valid receipt over the default fixture.
   * @returns The receipt.
   */
  async function valid(): Promise<VideoSourceLedgerReceipt> {
    const value = ledgerFixture('cfr.mp4');
    return measured(value, bytesOf(value));
  }

  it.each([
    ['size', { maxBytes: 10 }],
    ['physical frames', { maxPhysicalFrames: 16 }],
    ['occurrences', { maxOccurrences: 16 }],
  ])('refuses a receipt over the %s policy', async (_name, tighter) => {
    await refused(read(await valid(), { ...LIMITS, ...tighter }), 'over_limit');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', { maxBytes: 0 }],
    ['fraction', { maxPhysicalFrames: 1.5 }],
    ['unsafe', { maxOccurrences: Number.MAX_SAFE_INTEGER + 1 }],
    ['missing', { maxBytes: undefined as unknown as number }],
  ])('refuses %s limits', async (_name, bad) => {
    await refused(read(await valid(), { ...LIMITS, ...bad }), 'limits');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown schema version', { schemaVersion: 2 }],
    ['plain http URL', { url: 'http://assets.example.test/x.json' }],
    ['non-JSON type', { contentType: 'text/plain' }],
  ])('refuses a receipt with %s', async (_name, bad) => {
    await refused(read({ ...(await valid()), ...bad } as VideoSourceLedgerReceipt), 'receipt');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('C04–C06 responses that cannot be the companion', () => {
  it('refuses a successful response with no body', async () => {
    const value = ledgerFixture('K02');
    const receipt = await measured(value, bytesOf(value));
    answer(null);
    await expect(read(receipt)).rejects.toBeInstanceOf(EmptyBody);
  });

  it('refuses a short body even when Content-Length matches the receipt', async () => {
    const value = ledgerFixture('K02');
    const bytes = bytesOf(value);
    const receipt = await measured(value, bytes);
    answer(serve([bytes.subarray(0, bytes.byteLength - 1)]), {
      headers: { 'content-type': 'application/json', 'content-length': String(bytes.byteLength) },
    });
    await refused(read(receipt), 'size');
  });

  it('cancels an open stream that runs past the receipt size (C05)', async () => {
    const value = ledgerFixture('K03');
    const bytes = bytesOf(value);
    const served = serve([bytes, new Uint8Array([0x20])], 'hang');
    answer(served);
    await expect(read(await measured(value, bytes))).rejects.toBeInstanceOf(BodyTooLarge);
    expect(served.cancelled()).toBe(true);
  });

  it('cancels the unread body of a non-success response', async () => {
    const value = ledgerFixture('K03');
    const served = serve([bytesOf(value)], 'hang');
    answer(served, { status: 404 });
    await refused(read(await measured(value, bytesOf(value))), 'status');
    expect(served.cancelled()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'text/plain'],
  ])('cancels the unread body when the type is %s', async (_name, type) => {
    const value = ledgerFixture('K03');
    const served = serve([bytesOf(value)], 'hang');
    fetchMock.mockImplementationOnce(async () => {
      const res = new Response(served.stream, { status: 200 });
      if (type === undefined) res.headers.delete('content-type');
      else res.headers.set('content-type', type);
      return res;
    });
    await refused(read(await measured(value, bytesOf(value))), 'content_type');
    expect(served.cancelled()).toBe(true);
  });

  it('reads a JSON type spelled with case and parameters', async () => {
    const value = ledgerFixture('K03');
    const bytes = bytesOf(value);
    answer(serve([bytes]), { headers: { 'content-type': ' Application/JSON ; charset=utf-8' } });
    expect(await read(await measured(value, bytes))).toEqual(value);
  });
});

describe('C07–C10 the stored bytes decide', () => {
  it('refuses the same object in a different byte order (C07)', async () => {
    const value = ledgerFixture('K05');
    const bytes = bytesOf(value);
    const { schemaVersion, ...rest } = value;
    const reordered = bytesOf({ ...rest, schemaVersion });
    expect(reordered.byteLength).toBe(bytes.byteLength);
    answer(serve([reordered]));
    await refused(read(await measured(value, bytes)), 'digest');
  });

  it.each([
    // codecId takes any non-empty string, so only a fatal decode refuses it.
    ['malformed UTF-8', (b: Uint8Array) => {
      const c = b.slice();
      const at = new TextDecoder().decode(c).indexOf('"codecId":"') + '"codecId":"'.length;
      c[at] = 0xff;
      return c;
    }],
    ['trailing garbage', (b: Uint8Array) => new Uint8Array([...b, 0x78])],
  ])('refuses %s even when its size and digest match', async (_name, damage) => {
    const value = ledgerFixture('K05');
    const bytes = damage(bytesOf(value));
    answer(serve([bytes]));
    await refused(read(await measured(value, bytes)), 'content');
  });

  it('refuses a body whose attempt differs from the receipt', async () => {
    const value = ledgerFixture('K05');
    const body = { ...value, attempt: { jobId: 'another-attempt', deadlineAt: value.attempt.deadlineAt } };
    const bytes = bytesOf(body);
    answer(serve([bytes]));
    await refused(read(await measured(value, bytes)), 'content');
  });

  it('validates the body with no ETag header at all (C09)', async () => {
    const value = ledgerFixture('K08');
    const bytes = bytesOf(value);
    answer(serve([bytes]));
    expect(await read(await measured(value, bytes))).toEqual(value);
  });

  it.each([
    ['absent', undefined],
    ['understated', '3'],
    ['overstated', '999999'],
  ])('ignores a Content-Length that is %s (C10)', async (_name, length) => {
    const value = ledgerFixture('K08');
    const bytes = bytesOf(value);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (length !== undefined) headers['content-length'] = length;
    answer(serve([bytes]), { headers });
    expect(await read(await measured(value, bytes))).toEqual(value);
  });
});

describe('C11–C13 one read deadline and the caller signal', () => {
  /**
   * A receipt and the bytes it measures.
   * @returns Both.
   */
  async function stored(): Promise<{ receipt: VideoSourceLedgerReceipt; bytes: Uint8Array }> {
    const value = ledgerFixture('K01');
    const bytes = bytesOf(value);
    return { receipt: await measured(value, bytes), bytes };
  }

  it('does not GET once the read deadline has passed', async () => {
    const { receipt } = await stored();
    await expect(readVideoSourceLedger(receipt, LIMITS, { deadlineAt: clock })).rejects.toBeInstanceOf(DeadlinePassed);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not GET for a caller that already gave up', async () => {
    const { receipt } = await stored();
    const controller = new AbortController();
    controller.abort(new Error('left'));
    await expect(read(receipt, LIMITS, controller.signal)).rejects.toThrow('left');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels the body without reading when headers arrive at the deadline', async () => {
    const { receipt, bytes } = await stored();
    const served = serve([bytes], 'hang');
    fetchMock.mockImplementationOnce(async () => {
      clock += 60_000;
      return new Response(served.stream, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await expect(read(receipt)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(served.cancelled()).toBe(true);
  });

  it('stops a body that crosses the deadline', async () => {
    const { receipt, bytes } = await stored();
    const served = serve([bytes.subarray(0, 10)], 'hang');
    answer(served);
    await expect(readVideoSourceLedger(receipt, LIMITS, { deadlineAt: clock + 80 })).rejects.toThrow();
    expect(served.cancelled()).toBe(true);
  });

  it('stops the body read when the caller gives up during it', async () => {
    const { receipt, bytes } = await stored();
    const served = serve([bytes.subarray(0, 10)], 'hang');
    answer(served);
    const controller = new AbortController();
    const pending = read(receipt, LIMITS, controller.signal);
    setTimeout(() => controller.abort(new Error('left')), 20);
    await expect(pending).rejects.toThrow('left');
    expect(served.cancelled()).toBe(true);
  });

  it('returns nothing when the digest finishes after the deadline (C12)', async () => {
    const { receipt, bytes } = await stored();
    answer(serve([bytes]));
    const real = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      const digest = await real(algorithm, data);
      clock += 60_000;
      return digest;
    });
    await expect(read(receipt)).rejects.toBeInstanceOf(DeadlinePassed);
  });

  it('returns nothing when the caller gives up during the digest (C12)', async () => {
    const { receipt, bytes } = await stored();
    answer(serve([bytes]));
    const controller = new AbortController();
    const real = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      const digest = await real(algorithm, data);
      controller.abort(new Error('left'));
      return digest;
    });
    await expect(read(receipt, LIMITS, controller.signal)).rejects.toThrow('left');
  });
});

describe('main entry', () => {
  it('exports the reader and the existing default delivery budget', async () => {
    const entry = await import('../../index.js');
    expect(entry.readVideoSourceLedger).toBe(readVideoSourceLedger);
    expect(entry.VideoSourceLedgerReadRefused).toBe(VideoSourceLedgerReadRefused);
    expect(entry.DEFAULT_TIMEOUT_MS).toBe(300_000);
  });
});
