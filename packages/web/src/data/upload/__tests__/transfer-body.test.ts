// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `bodyOrTransfer` (inner#1006 design §4.7): a request body over the server's
 * limit is written as a transfer file, uploaded through the ingest Worker, and
 * replaced by `{ transfer: storageKey }`; a body within the limit, or a server
 * that does not name a limit, goes out unchanged.
 *
 * Every network step is stubbed where the rest of the upload path is: the
 * ticket and the finish are `apiPost` calls, the parts go through
 * `sendBytesToIngest` from `@breatic/shared`, and the ending comes from
 * `waitForUploadEnding`. Each stub writes its name into `steps`, so the order
 * is asserted as well as the calls.
 *
 * Test spec: inner engineering/research/2026-10-24-1006-test-spec.md §7.1
 * (W01-W07, W15-W17, P03) and the browser halves of §6.1 S03, S07, S15, S25.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import type * as SharedModule from '@breatic/shared';
import type * as RequestModule from '@web/data/api/request';
import type * as UploadStatusModule from '@web/data/upload/upload-status';

vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));
vi.mock('@breatic/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModule>()),
  sendBytesToIngest: vi.fn(),
}));
vi.mock('@web/data/upload/upload-status', async (importOriginal) => ({
  ...(await importOriginal<typeof UploadStatusModule>()),
  waitForUploadEnding: vi.fn(),
}));

import { encodeTransferBody, sendBytesToIngest } from '@breatic/shared';
import type { HeldUpload } from '@breatic/shared';
import { apiGet, apiPost } from '@web/data/api/request';
import { assetsApi } from '@web/data/api/assets';
import { ApiException } from '@web/data/api/types';
import type { UploadTicket } from '@web/data/upload/ingest-upload';
import { waitForUploadEnding, type UploadEnding } from '@web/data/upload/upload-status';
import { bodyOrTransfer } from '@web/data/upload/transfer-body';

const P = '11111111-1111-4111-8111-111111111111';
const KEY = 'transfer/2026-10-24/1_00000000-0000-4000-8000-000000000001.transfer';
const SIGNATURE = 'BREATIC-TRANSFER/1\n';
const LIMIT = 1048576;

const TICKET: UploadTicket = {
  ticket: 'signed-ticket',
  storageKey: KEY,
  uploadUrl: 'https://ingest.test.invalid',
  kind: 'file',
  partSize: 8 * 1024 * 1024,
  totalParts: 1,
};

const HELD: HeldUpload = {
  uploadId: 'upload-1',
  token: 'part-token',
  parts: [{ partNumber: 1, etag: 'etag-1' }],
};

/** The order the stubbed steps ran in. */
let steps: string[] = [];

/** The bytes handed to the ingest Worker, read off the Blob. */
let sentBlob: Blob | null = null;

/**
 * What the upload-config endpoint answers, with the given request-body limit.
 * @param maxRequestBodyBytes - The limit, exactly as the server would send it.
 * @returns The config object.
 */
function configWith(maxRequestBodyBytes: unknown): Record<string, unknown> {
  return {
    maxUploadBytes: 2 * 1024 * 1024 * 1024,
    clientMaxAttempts: 3,
    clientRetryBaseDelayMs: 1,
    uploadIdleTimeoutMs: 30_000,
    assetUrlPrefix: 'https://assets.test.invalid/',
    uploadStatusPollSeconds: 1,
    maxRequestBodyBytes,
  };
}

/**
 * Serve the config with this limit from now on, and drop the session cache.
 * @param maxRequestBodyBytes - The limit.
 */
function serveLimit(maxRequestBodyBytes: unknown): void {
  assetsApi.resetUploadConfigCache();
  vi.mocked(apiGet).mockImplementation(async (url: string) => {
    if (url === '/assets/upload-config') return configWith(maxRequestBodyBytes);
    throw new Error(`unexpected GET ${url}`);
  });
}

/**
 * Whether this apiPost call asked for a transfer ticket.
 * @param url - The call's URL.
 * @returns True for the ticket endpoint.
 */
function isTicket(url: string): boolean {
  return url === '/assets/transfer-ticket';
}

/**
 * Whether this apiPost call finished an upload.
 * @param url - The call's URL.
 * @returns True for the finish endpoint.
 */
function isFinish(url: string): boolean {
  return /^\/assets\/uploads\/[^/]+\/complete$/.test(url);
}

/**
 * The apiPost calls to one endpoint.
 * @param match - Which endpoint.
 * @returns Their arguments.
 */
function postsTo(match: (url: string) => boolean): unknown[][] {
  return vi.mocked(apiPost).mock.calls.filter(([url]) => match(url)) as unknown[][];
}

/**
 * The signal one apiPost call carried in its axios config.
 * @param call - The call's arguments.
 * @returns The signal, or undefined when none was passed.
 */
function signalOf(call: unknown[] | undefined): unknown {
  const config = call?.[2] as { signal?: unknown } | undefined;
  return config?.signal;
}

/**
 * The Blob handed to the ingest Worker; fails the test when none was.
 * @returns It.
 * @throws {Error} When nothing was sent.
 */
function lastSent(): Blob {
  if (sentBlob === null) throw new Error('nothing was sent to the ingest Worker');
  return sentBlob;
}

/**
 * Read a Blob's bytes.
 * @param blob - The Blob.
 * @returns Its bytes.
 */
async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Assert two byte sequences are equal, byte for byte. Compared by index rather
 * than with toEqual, because TextEncoder's Uint8Array and the page's come from
 * different realms under jsdom and toEqual tells them apart by constructor.
 * @param actual - The bytes observed.
 * @param expected - The bytes they must equal.
 */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  const firstDifference = actual.findIndex((byte, index) => byte !== expected[index]);
  expect(firstDifference).toBe(-1);
}

/**
 * An AbortError the way fetch and axios raise one.
 * @returns The error.
 */
function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Install the default stubs: every step succeeds at once and records itself.
 */
function stubEveryStep(): void {
  vi.mocked(apiPost).mockImplementation(async (url: string) => {
    if (isTicket(url)) {
      steps.push('ticket');
      return TICKET;
    }
    if (isFinish(url)) {
      steps.push('finish');
      return { storageKey: KEY };
    }
    throw new Error(`unexpected POST ${url}`);
  });
  vi.mocked(sendBytesToIngest).mockImplementation(async (bytes: Blob) => {
    steps.push('send');
    sentBlob = bytes;
    return HELD;
  });
  vi.mocked(waitForUploadEnding).mockImplementation(async (key: string) => {
    steps.push('wait');
    return { key, state: 'transferred' } as UploadEnding;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  steps = [];
  sentBlob = null;
  serveLimit(LIMIT);
  stubEveryStep();
});

afterEach(() => {
  assetsApi.resetUploadConfigCache();
});

describe('bodyOrTransfer: the threshold, counted in UTF-8 bytes of JSON.stringify', () => {
  it('W01 returns the very object at exactly the limit and starts no transfer', async () => {
    const body = { t: 'a'.repeat(1048568) };
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBe(1048576);
    const onTransferStart = vi.fn();

    const out = await bodyOrTransfer(P, body, { onTransferStart });

    expect(out).toBe(body);
    expect(onTransferStart).toHaveBeenCalledTimes(0);
    expect(postsTo(isTicket)).toHaveLength(0);
    expect(steps).toEqual([]);
  });

  it('W02 transfers one byte over the limit, in order, and returns the reference', async () => {
    const body = { t: 'a'.repeat(1048569) };
    const onTransferStart = vi.fn(() => {
      steps.push('start');
    });

    const out = await bodyOrTransfer(P, body, { onTransferStart });

    expect(out).toEqual({ transfer: KEY });
    expect(steps).toEqual(['start', 'ticket', 'send', 'finish', 'wait']);
    expect(onTransferStart).toHaveBeenCalledTimes(1);
    const [ticket] = postsTo(isTicket);
    expect(ticket?.[1]).toEqual({ project_id: P, size: 1048596 });
    expect(vi.mocked(waitForUploadEnding)).toHaveBeenCalledWith(KEY);
  });

  it('W03 counts bytes, not characters', async () => {
    const atLimit = { t: '中'.repeat(349522) + 'aa' };
    expect(atLimit.t).toHaveLength(349524);
    expect(new TextEncoder().encode(JSON.stringify(atLimit)).length).toBe(1048576);

    expect(await bodyOrTransfer(P, atLimit)).toBe(atLimit);
    expect(postsTo(isTicket)).toHaveLength(0);

    const over = { t: '中'.repeat(349522) + 'aaa' };
    expect(await bodyOrTransfer(P, over)).toEqual({ transfer: KEY });
    expect(postsTo(isTicket)[0]?.[1]).toEqual({ project_id: P, size: 1048596 });
  });

  it('W04 does not escape "<", so it does not grow the count', async () => {
    const body = { t: '<'.repeat(174761) + 'aaa' };
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBe(174772);

    expect(await bodyOrTransfer(P, body)).toBe(body);
    expect(postsTo(isTicket)).toHaveLength(0);
  });

  it('W16 counts what JSON.stringify writes: a control character costs six bytes', async () => {
    const body = { t: '\u0001'.repeat(174763) };
    const json = JSON.stringify(body);
    expect(new TextEncoder().encode(json).length).toBe(1048586);

    expect(await bodyOrTransfer(P, body)).toEqual({ transfer: KEY });
    expect(postsTo(isTicket)[0]?.[1]).toEqual({ project_id: P, size: 1048605 });
    const sent = await bytesOf(lastSent());
    expectSameBytes(sent.subarray(19), new TextEncoder().encode(json));
  });

  it('W17 sends exactly encodeTransferBody of the JSON, signature first', async () => {
    const body = { t: 'a'.repeat(1048569) };

    await bodyOrTransfer(P, body);

    const blob = lastSent();
    expect(blob.size).toBe(1048596);
    const sent = await bytesOf(blob);
    expect(new TextDecoder().decode(sent.subarray(0, 19))).toBe(SIGNATURE);
    expectSameBytes(sent, encodeTransferBody(JSON.stringify(body)));
  });
});

describe('bodyOrTransfer: a server that names no usable limit (W15)', () => {
  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '1048576'],
    ['NaN', Number.NaN],
  ])('sends a 5 MB body unchanged when the limit is %s', async (_case, limit) => {
    serveLimit(limit);
    const body = { t: 'a'.repeat(5 * 1024 * 1024) };
    const onTransferStart = vi.fn();

    const out = await bodyOrTransfer(P, body, { onTransferStart });

    expect(out).toBe(body);
    expect(onTransferStart).toHaveBeenCalledTimes(0);
    expect(postsTo(isTicket)).toHaveLength(0);
    expect(vi.mocked(sendBytesToIngest)).toHaveBeenCalledTimes(0);
  });
});

describe('bodyOrTransfer: failures go to the caller', () => {
  const big = (): { t: string } => ({ t: 'a'.repeat(1048569) });

  it.each([
    ['failed', { key: KEY, state: 'failed', reason: 'unsupported_type' }],
    ['unknown', { key: KEY, state: 'unknown' }],
  ])('W05 rejects when the upload ended %s, and returns no reference', async (_case, ending) => {
    vi.mocked(waitForUploadEnding).mockResolvedValue(ending as UploadEnding);

    await expect(bodyOrTransfer(P, big())).rejects.toBeInstanceOf(Error);
  });

  it.each([
    ['rate limited', new ApiException({ status: 429, message: 'slow down', fromServer: true })],
    ['over the transfer cap', new ApiException({ status: 422, message: 'invalid', fromServer: true })],
  ])('W06 throws the ticket refusal (%s) as it came, and sends nothing', async (_case, refusal) => {
    vi.mocked(apiPost).mockImplementation(async (url: string) => {
      if (isTicket(url)) throw refusal;
      throw new Error(`unexpected POST ${url}`);
    });

    await expect(bodyOrTransfer(P, big())).rejects.toBe(refusal);
    expect(vi.mocked(sendBytesToIngest)).toHaveBeenCalledTimes(0);
  });
});

describe('bodyOrTransfer: cancelling between steps (W07, S03, S07, S15, S25)', () => {
  const big = (): { t: string } => ({ t: 'a'.repeat(1048569) });

  it('S03 throws AbortError for a signal already aborted, and asks for no ticket', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(bodyOrTransfer(P, big(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(postsTo(isTicket)).toHaveLength(0);
  });

  it('W07 aborted in onTransferStart: no ticket', async () => {
    const controller = new AbortController();

    const run = bodyOrTransfer(P, big(), {
      signal: controller.signal,
      onTransferStart: () => controller.abort(),
    });

    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(postsTo(isTicket)).toHaveLength(0);
  });

  it('W07 aborted once the ticket came back: no bytes are sent', async () => {
    const controller = new AbortController();
    vi.mocked(apiPost).mockImplementation(async (url: string) => {
      if (isTicket(url)) {
        controller.abort();
        return TICKET;
      }
      throw new Error(`unexpected POST ${url}`);
    });

    await expect(bodyOrTransfer(P, big(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(vi.mocked(sendBytesToIngest)).toHaveBeenCalledTimes(0);
  });

  it('W07 aborted once the bytes landed: the finish is never asked for', async () => {
    const controller = new AbortController();
    vi.mocked(sendBytesToIngest).mockImplementation(async () => {
      controller.abort();
      return HELD;
    });

    await expect(bodyOrTransfer(P, big(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(postsTo(isFinish)).toHaveLength(0);
  });

  it('W07 aborted while waiting for the ending: rejects without the ending', async () => {
    const controller = new AbortController();
    vi.mocked(waitForUploadEnding).mockImplementation(() => {
      // The ending never comes; only the abort can end this wait.
      setTimeout(() => controller.abort(), 0);
      return new Promise<UploadEnding>(() => undefined);
    });

    await expect(bodyOrTransfer(P, big(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('W07 hands the ticket and the finish the same signal', async () => {
    const controller = new AbortController();

    await bodyOrTransfer(P, big(), { signal: controller.signal });

    const ticketSignal = signalOf(postsTo(isTicket)[0]);
    const finishSignal = signalOf(postsTo(isFinish)[0]);
    expect(ticketSignal).toBeInstanceOf(AbortSignal);
    expect(finishSignal).toBe(ticketSignal);
  });

  it('S07 aborted while the parts are being sent: AbortError, no finish', async () => {
    const controller = new AbortController();
    vi.mocked(sendBytesToIngest).mockImplementation(async (...args: unknown[]) => {
      // The stand-in for the new sendBytesToIngest: it stops when the signal
      // it was handed aborts, the way the shared one is specified to.
      const signal = args.find((arg): arg is AbortSignal => arg instanceof AbortSignal);
      controller.abort();
      if (signal?.aborted === true) throw abortError();
      return HELD;
    });

    await expect(bodyOrTransfer(P, big(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(postsTo(isFinish)).toHaveLength(0);
  });

  it('S15 aborted while polling after the finish was queued: AbortError, no reference', async () => {
    const controller = new AbortController();
    let polled = false;
    vi.mocked(waitForUploadEnding).mockImplementation(() => {
      polled = true;
      queueMicrotask(() => controller.abort());
      return new Promise<UploadEnding>(() => undefined);
    });

    await expect(bodyOrTransfer(P, big(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(polled).toBe(true);
    expect(postsTo(isFinish)).toHaveLength(1);
  });

  it('S25 aborted after the ending said transferred: AbortError instead of the reference', async () => {
    const controller = new AbortController();
    vi.mocked(waitForUploadEnding).mockImplementation(async (key: string) => {
      controller.abort();
      return { key, state: 'transferred' } as UploadEnding;
    });

    await expect(bodyOrTransfer(P, big(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('bodyOrTransfer: the threshold decides, for any body (P03)', () => {
  const prefixed = fc
    .constantFrom('<svg ', '<SVG/', '&amp;', '\u0000')
    .chain((head) => fc.string({ unit: 'binary', maxLength: 4000 }).map((tail) => head + tail));
  const anyBody = fc.oneof(
    fc.jsonValue({ stringUnit: 'binary' }),
    prefixed,
    fc.record({ t: prefixed }),
    fc.record({ t: fc.string({ unit: 'binary', maxLength: 4000 }) }),
  );

  it('returns the body itself iff it fits, else a reference to exactly its encoding', async () => {
    await fc.assert(
      fc.asyncProperty(anyBody, fc.integer({ min: 64, max: 8192 }), async (body, max) => {
        vi.clearAllMocks();
        steps = [];
        sentBlob = null;
        serveLimit(max);
        stubEveryStep();
        const json = JSON.stringify(body);
        const size = new TextEncoder().encode(json).length;

        const out = await bodyOrTransfer(P, body);

        if (size <= max) {
          expect(out).toBe(body);
          expect(postsTo(isTicket)).toHaveLength(0);
          return;
        }
        expect(out).toEqual({ transfer: KEY });
        expect(postsTo(isTicket).map((call) => call[1])).toEqual([{ project_id: P, size: 19 + size }]);
        expectSameBytes(await bytesOf(lastSent()), encodeTransferBody(json));
      }),
      { numRuns: 100 },
    );
  });
});
