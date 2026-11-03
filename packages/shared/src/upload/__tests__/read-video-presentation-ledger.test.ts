// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The bounded full-ledger reader behind the version-resolution exit (inner#1306
 * test plan §90 E3-7; frames-split design §5.3 「版本解析出口」, §3.5 full
 * ledger/receipt, §3.2 item 7).
 *
 * `readVideoPresentationLedger(receipt, limits, bound)` reads the full object the
 * receipt names, refuses bytes whose size or SHA-256 differ from the receipt or
 * exceed the byte budget, parses the strict S6a full schema (encode facts
 * included) and refuses a body whose toolInputId, planSha256 or source differs
 * from the receipt. Transport, deadline and cancellation are the shared measured
 * read and are not repeated here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as entry from '../../index.js';

type Read = (receipt: unknown, limits: { maxBytes: number }, bound: { deadlineAt: number; signal?: AbortSignal }) => Promise<unknown>;
const api = entry as unknown as { readVideoPresentationLedger?: Read };

const H = 'a'.repeat(64);
const r = (numerator: number, denominator = 1): { numerator: string; denominator: string } => ({ numerator: String(numerator), denominator: String(denominator) });
const plan = {
  display: { width: 64, height: 48, duration: r(17, 8) }, colorMatrix: 'bt601', source: { transfer: null, bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 }, policy: { singleFrameDurationMs: 5000, emptyFill: 'black' },
  presentation: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 17, step: 1, duration: 1 }] },
  originMapping: {
    timeBase: r(1, 16384), origin: r(0), entries: [{ kind: 'source', start: 4096, count: 17, step: 2048 }],
    firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'declared', supportEnd: r(17, 8), hold: null },
  },
  videoSpans: [{ sourceStart: r(1, 4), sourceEnd: r(19, 8), presentationStart: r(0), rate: r(1) }],
  audioSpans: null, segmentDuration: null,
};
const fullURL = 'https://assets.example.test/video/fixture.mp4.ledger.json';
const tableURL = 'https://assets.example.test/video/fixture.mp4.table.json';
const limits = { maxBytes: 1_000_000 };
const fetchMock = vi.fn<typeof fetch>();
let ledger: Record<string, unknown>;

/**
 * The reader under test, read at call time so a missing export fails each case on its own.
 * @returns It.
 */
function reader(): Read {
  expect(api.readVideoPresentationLedger, 'readVideoPresentationLedger is exported from @breatic/shared').toBeTypeOf('function');
  return api.readVideoPresentationLedger!;
}

/**
 * Lowercase SHA-256 of bytes.
 * @param bytes - The bytes.
 * @returns The digest.
 */
async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The receipt of some full bytes.
 * @param bytes - The stored full bytes.
 * @param body - The parsed body the identity fields come from.
 * @returns The S6a receipt.
 */
async function receiptFor(bytes: Uint8Array, body: Record<string, unknown> = ledger): Promise<Record<string, unknown>> {
  return {
    schemaVersion: 2, sourceFingerprint: body.sourceFingerprint, toolInputId: body.toolInputId, planSha256: body.planSha256, producerVersion: 2,
    attempt: body.attempt, url: fullURL, etag: 'etag-full', size: bytes.length, sha256: await sha256(bytes), contentType: 'application/json',
    table: { url: tableURL, sha256: 'c'.repeat(64), size: 81, contentType: 'application/json', frameCount: 17 },
  };
}

/**
 * Serve bytes once.
 * @param bytes - The body.
 */
function serve(bytes: Uint8Array): void {
  fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/json' } }));
}

beforeEach(async () => {
  const planSha256 = await (entry as unknown as { videoPresentationPlanSha256: (value: unknown) => Promise<string> }).videoPresentationPlanSha256(plan);
  const toolInputId = await (entry as unknown as { videoPresentationToolInputId: (value: unknown) => Promise<string> }).videoPresentationToolInputId({ sourceFingerprint: H, planSha256 });
  ledger = { schemaVersion: 2, sourceFingerprint: H, toolInputId, planSha256, attempt: { jobId: 'video-presentation:job-1', deadlineAt: 1_900_000_000_000 }, plan,
    encoding: { keyframeOrdinals: [0, 8], codedWidth: 64, codedHeight: 48 } };
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bounded full-ledger read (inner#1306 §5.3, §3.5)', () => {
  it('RL01 returns the whole validated full ledger, encode facts included, from the receipt\'s own URL', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(ledger));
    serve(bytes);
    expect(await reader()(await receiptFor(bytes), limits, { deadlineAt: Date.now() + 60_000 })).toEqual(ledger);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(fullURL);
  });

  it.each([
    ['a body one byte longer than the receipt', async (bytes: Uint8Array) => ({ served: new Uint8Array([...bytes, 32]), receipt: await receiptFor(bytes) })],
    ['a body with another digest', async (bytes: Uint8Array) => {
      const other = new TextEncoder().encode(JSON.stringify({ ...ledger, attempt: { jobId: 'video-presentation:job-2', deadlineAt: 1_900_000_000_000 } }));
      return { served: other, receipt: { ...await receiptFor(bytes), size: other.length } };
    }],
    ['a body over the byte budget', async (bytes: Uint8Array) => ({ served: bytes, receipt: await receiptFor(bytes), maxBytes: bytes.length - 1 })],
    ['a body without its encode facts', async () => {
      const { encoding: _dropped, ...without } = ledger;
      const bytes = new TextEncoder().encode(JSON.stringify(without));
      return { served: bytes, receipt: await receiptFor(bytes) };
    }],
    ['a body whose toolInputId differs from the receipt', async () => {
      const body = { ...ledger, toolInputId: 'b'.repeat(64) };
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      return { served: bytes, receipt: { ...await receiptFor(bytes, body), toolInputId: ledger.toolInputId } };
    }],
    ['a body whose planSha256 differs from the receipt', async () => {
      const body = { ...ledger, planSha256: 'b'.repeat(64) };
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      return { served: bytes, receipt: { ...await receiptFor(bytes, body), planSha256: ledger.planSha256 } };
    }],
    ['a body of another source', async () => {
      const body = { ...ledger, sourceFingerprint: 'b'.repeat(64) };
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      return { served: bytes, receipt: { ...await receiptFor(bytes, body), sourceFingerprint: H } };
    }],
  ])('RL02 refuses %s', async (_name, make) => {
    const bytes = new TextEncoder().encode(JSON.stringify(ledger));
    serve(bytes);
    await expect(reader()(await receiptFor(bytes), limits, { deadlineAt: Date.now() + 60_000 })).resolves.toEqual(ledger);
    const { served, receipt, maxBytes } = await make(bytes) as { served: Uint8Array; receipt: Record<string, unknown>; maxBytes?: number };
    serve(served);
    await expect(reader()(receipt, { maxBytes: maxBytes ?? limits.maxBytes }, { deadlineAt: Date.now() + 60_000 })).rejects.toThrow();
  });

  it('RL03 does not read once its deadline has passed', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(ledger));
    await expect(reader()(await receiptFor(bytes), limits, { deadlineAt: Date.now() - 1 })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
