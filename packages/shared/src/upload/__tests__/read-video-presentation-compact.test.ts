// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * S6a bounded compact reader (inner#1306, test plan §87; frames-split design
 * §3.5 "compact body", test plan §78 mapping rows R01 and R07–R09).
 *
 * The compact object is the envelope sourceFingerprint/toolInputId/planSha256/
 * presentation. receipt.table's hash and size measure the whole envelope and its
 * frameCount counts the inner presentation; the table receipt carries its own
 * contentType. The reader validates the complete
 * envelope against the receipt first and only then hands back the S1 table;
 * a missing, extra or mismatching envelope field is refused as `content`.
 * Transport, deadline and cancellation behaviour are the existing measured read
 * (S4 R10–R20) and are not repeated here.
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as entry from '../../index.js';
import type { VideoPresentationTable } from '../../mini-tools/video-presentation-table.js';

interface Receipt {
  schemaVersion: 2; sourceFingerprint: string; toolInputId: string; planSha256: string; producerVersion: number; attempt: { jobId: string; deadlineAt: number };
  url: string; etag: string; size: number; sha256: string; contentType: 'application/json';
  table: { url: string; sha256: string; size: number; contentType: 'application/json'; frameCount: number };
}
type Read = (receipt: unknown, policy: { maxBytes: number }, options: { deadlineAt: number; signal?: AbortSignal }) => Promise<VideoPresentationTable>;
const api = entry as unknown as { readVideoPresentationCompact?: Read };

const H = 'a'.repeat(64);
const TOOL = 'c'.repeat(64);
const PLAN = 'd'.repeat(64);
const fullURL = 'https://assets.example.test/video/fixture/job-1.full.json';
const tableURL = 'https://assets.example.test/video/fixture/job-1.compact.json';
const table: VideoPresentationTable = { schemaVersion: 1, timescale: 4, runs: [{ start: 0, count: 3, step: 1, duration: 1 }, { start: 3, count: 1, step: 5, duration: 5 }] };
const envelope = { sourceFingerprint: H, toolInputId: TOOL, planSha256: PLAN, presentation: table };
const policy = { maxBytes: 1_000_000 };
const fetchMock = vi.fn<typeof fetch>();
let now = 1_800_000_000_000;

/**
 * The reader under test, failing when it is not exported yet.
 * @returns The reader.
 * @throws {Error} When the export is missing.
 */
function reader(): Read {
  expect(api.readVideoPresentationCompact, 'readVideoPresentationCompact is exported from @breatic/shared').toBeDefined();
  return api.readVideoPresentationCompact!;
}

/**
 * Serializes a fixture.
 * @param value - The value.
 * @returns Its JSON bytes.
 */
function bytesOf(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }

/**
 * A receipt measuring exactly these compact bytes.
 * @param bytes - The stored compact bytes.
 * @param frameCount - The counted frames.
 * @returns The receipt.
 */
async function receiptFor(bytes: Uint8Array, frameCount = 4): Promise<Receipt> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return {
    schemaVersion: 2, sourceFingerprint: H, toolInputId: TOOL, planSha256: PLAN, producerVersion: 2, attempt: { jobId: 'video-presentation:job-1', deadlineAt: 1_800_000_900_000 },
    url: fullURL, etag: 'etag-full', size: 900, sha256: 'f'.repeat(64), contentType: 'application/json',
    table: { url: tableURL, size: bytes.length, contentType: 'application/json', frameCount, sha256: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('') },
  };
}

/**
 * Serve one response.
 * @param bytes - The body.
 */
function answer(bytes: Uint8Array): void {
  fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/json' } }));
}

/**
 * Read with one absolute deadline.
 * @param receipt - The receipt.
 * @param maxBytes - The byte policy.
 * @returns The inner table.
 */
async function read(receipt: unknown, maxBytes = policy.maxBytes): Promise<VideoPresentationTable> {
  return reader()(receipt, { maxBytes }, { deadlineAt: now + 1000 });
}

/**
 * Every refusal first shows that the valid envelope is read.
 * @returns The valid receipt.
 */
async function accepts(): Promise<Receipt> {
  const bytes = bytesOf(envelope);
  const receipt = await receiptFor(bytes);
  answer(bytes);
  expect(await read(receipt)).toEqual(table);
  fetchMock.mockClear();
  return receipt;
}

beforeEach(() => { now = 1_800_000_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('RC S6a compact envelope bounded read', () => {
  it('RC01 returns only the inner S1 table and GETs only the compact URL, never the full ledger', async () => {
    await accepts();
    answer(bytesOf(envelope));
    expect(await read(await receiptFor(bytesOf(envelope)))).toEqual(table);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([tableURL]);
  });

  it('RC02 refuses the bare S1 table, the earlier compact shape, even when size and digest match', async () => {
    await accepts();
    const bytes = bytesOf(table);
    answer(bytes);
    await expect(read(await receiptFor(bytes))).rejects.toMatchObject({ reason: 'content' });
  });

  it.each([
    ['another source fingerprint', { ...envelope, sourceFingerprint: 'b'.repeat(64) }],
    ['another toolInputId', { ...envelope, toolInputId: 'b'.repeat(64) }],
    ['another planSha256', { ...envelope, planSha256: 'b'.repeat(64) }],
    ['a missing toolInputId', { sourceFingerprint: H, planSha256: PLAN, presentation: table }],
    ['a missing planSha256', { sourceFingerprint: H, toolInputId: TOOL, presentation: table }],
    ['a missing source fingerprint', { toolInputId: TOOL, planSha256: PLAN, presentation: table }],
    ['an extra versionId', { ...envelope, versionId: 'e'.repeat(64) }],
    ['an extra frames array', { ...envelope, frames: [] }],
    ['an invalid inner table', { ...envelope, presentation: { ...table, runs: [] } }],
  ])('RC03 refuses an envelope with %s as content', async (_, value) => {
    await accepts();
    const bytes = bytesOf(value);
    answer(bytes);
    await expect(read(await receiptFor(bytes))).rejects.toMatchObject({ reason: 'content' });
  });

  it.each([3, 5])('RC04 refuses a receipt frameCount %i differing from the inner presentation', async (count) => {
    await accepts();
    const bytes = bytesOf(envelope);
    answer(bytes);
    await expect(read(await receiptFor(bytes, count))).rejects.toMatchObject({ reason: 'content' });
  });

  it.each([
    ['the earlier v2 receipt', (value: Receipt): unknown => ({ ...value, toolInputId: undefined, planSha256: undefined, table: { ...value.table, contentType: undefined } })],
    ['a table receipt without its contentType', (value: Receipt): unknown => ({ ...value, table: { ...value.table, contentType: undefined } })],
    ['a missing toolInputId', (value: Receipt): unknown => { const { toolInputId: _, ...rest } = value; return rest; }],
    ['a table at the ledger URL', (value: Receipt): unknown => ({ ...value, table: { ...value.table, url: fullURL } })],
    ['a bare table receipt', (value: Receipt): unknown => value.table],
  ])('RC05 refuses %s before fetching', async (_, change) => {
    const receipt = await accepts();
    await expect(read(JSON.parse(JSON.stringify(change(receipt))))).rejects.toMatchObject({ reason: 'receipt' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RC06 refuses a compact object larger than the byte policy before fetching', async () => {
    const receipt = await accepts();
    await expect(read(receipt, receipt.table.size - 1)).rejects.toMatchObject({ reason: 'over_limit' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RC07 any valid run table inside a matching envelope comes back unchanged (property)', async () => {
    const valid = await accepts();
    expect(valid.table.frameCount).toBe(4);
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000_000 }), fc.integer({ min: 1, max: 100 }), async (count, step) => {
      const inner = { schemaVersion: 1, timescale: 1000, runs: [{ start: 0, count, step, duration: step }] };
      const bytes = bytesOf({ ...envelope, presentation: inner });
      answer(bytes);
      expect(await read(await receiptFor(bytes, count))).toEqual(inner);
    }), { seed: 130604, numRuns: 30 });
  });
});
