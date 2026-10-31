// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as entry from '../../index.js';
import type { VideoPresentationTable } from '../../mini-tools/video-presentation-table.js';
import { BodyTooLarge } from '../../http/read-within.js';
import { DeadlinePassed } from '../../http/deadline.js';

// S4 oracle: the shared entry is the actual consumer boundary, not a test parser.
type Receipt = { url: string; sha256: string; size: number; frameCount: number };
type Read = (receipt: Receipt, policy: { maxBytes: number }, options: { deadlineAt: number; signal?: AbortSignal }) => Promise<VideoPresentationTable>;
const api = entry as unknown as { readVideoPresentationTable: Read };
const table: VideoPresentationTable = { schemaVersion: 1, timescale: 1000, runs: [{ start: 2000, count: 3, step: 40, duration: 30 }, { start: 3000, count: 1, step: 20, duration: 20 }] };
const policy = { maxBytes: 1_000_000 };
const url = 'https://assets.example.test/source.presentation-table.json';
const fetchMock = vi.fn<typeof fetch>();
let now = 1_800_000_000_000;

/** Measures precisely the stored bytes. @throws {Error} When WebCrypto fails. */
async function receiptFor(bytes: Uint8Array, frameCount = 4): Promise<Receipt> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return { url, size: bytes.length, frameCount, sha256: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('') };
}
/** Serializes a fixture, without implementing validation. @throws {Error} When JSON cannot serialize it. */
function bytesOf(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
/** Serves one real response. @throws {Error} When the fixture is not a valid response. */
function answer(bytes: Uint8Array, init: ResponseInit = {}): void {
  fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/json' }, ...init }));
}
/** Invokes the public reader with one absolute deadline. @throws {Error} When validation refuses the body. */
async function read(receipt: Receipt, signal?: AbortSignal): Promise<VideoPresentationTable> {
  return api.readVideoPresentationTable(receipt, policy, { deadlineAt: now + 1000, signal });
}
/** Every refusal first demonstrates acceptance of its valid control. @throws {Error} When the reader refuses a valid table. */
async function accepts(): Promise<Receipt> {
  const bytes = bytesOf(table);
  const receipt = await receiptFor(bytes);
  answer(bytes);
  expect(await read(receipt)).toEqual(table);
  fetchMock.mockClear();
  return receipt;
}

beforeEach(() => { now = 1_800_000_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('S4 compact table bounded read', () => {
  it('R01 returns only the complete table and GETs only the compact URL', async () => {
    await accepts();
    answer(bytesOf(table), { headers: { 'content-type': 'Application/JSON; charset=utf-8', 'content-length': '1' } });
    expect(await read(await receiptFor(bytesOf(table)))).toEqual(table);
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(url);
  });
  it('R02 accepts a billion frames when the run bytes fit, without an occurrence cap', async () => {
    const value = { schemaVersion: 1, timescale: 1000, runs: [{ start: 0, count: 1_000_000_000, step: 1, duration: 1 }] };
    const bytes = bytesOf(value); answer(bytes);
    expect(await read(await receiptFor(bytes, 1_000_000_000))).toEqual(value);
  });
  it('R03 preserves arbitrary valid run counts and gaps (property)', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 100 }), async (count, step) => {
      const value = { schemaVersion: 1, timescale: 1000, runs: [{ start: 17, count, step, duration: step }] };
      const bytes = bytesOf(value); answer(bytes);
      expect(await read(await receiptFor(bytes, count))).toEqual(value);
    }), { seed: 130604, numRuns: 30 });
  });
  it.each([
    ['http URL', { url: 'http://assets.example.test/table' }], ['empty URL', { url: '' }],
    ['digest', { sha256: 'z'.repeat(64) }], ['zero size', { size: 0 }], ['fraction size', { size: 1.5 }],
    ['zero frame count', { frameCount: 0 }], ['unsafe count', { frameCount: Number.MAX_SAFE_INTEGER + 1 }],
    ['unknown field', { frames: [] }],
  ])('R04 rejects invalid receipt %s before fetching', async (_name, patch) => {
    const receipt = await accepts();
    await expect(read({ ...receipt, ...patch })).rejects.toMatchObject({ reason: 'receipt' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('R05 rejects invalid byte policy %s', async (maxBytes) => {
    const receipt = await accepts();
    await expect(api.readVideoPresentationTable(receipt, { maxBytes }, { deadlineAt: now + 1000 })).rejects.toMatchObject({ reason: 'limits' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('R06 refuses an over-byte-policy receipt before fetching', async () => {
    const receipt = await accepts();
    await expect(api.readVideoPresentationTable(receipt, { maxBytes: receipt.size - 1 }, { deadlineAt: now + 1000 })).rejects.toMatchObject({ reason: 'over_limit' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    ['empty runs', { ...table, runs: [] }], ['unknown field', { ...table, frames: [] }],
    ['overlap', { ...table, runs: [{ start: 0, count: 4, step: 20, duration: 21 }] }],
    ['unsafe end', { ...table, runs: [{ start: Number.MAX_SAFE_INTEGER, count: 4, step: 20, duration: 20 }] }],
    ['wrong version', { ...table, schemaVersion: 2 }], ['invalid clock', { ...table, timescale: 0 }],
  ])('R07 refuses %s with matching stored size and digest', async (_name, value) => {
    await accepts(); const bytes = bytesOf(value); answer(bytes);
    await expect(read(await receiptFor(bytes))).rejects.toMatchObject({ reason: 'content' });
  });
  it.each([3, 5])('R08 refuses receipt frameCount %s differing from sum(runs.count)', async (count) => {
    await accepts(); const bytes = bytesOf(table); answer(bytes);
    await expect(read(await receiptFor(bytes, count))).rejects.toMatchObject({ reason: 'content' });
  });
  it.each([new Uint8Array([0xff]), new TextEncoder().encode('{"schemaVersion":1}garbage')])('R09 refuses invalid UTF8 or JSON despite matching digest', async (bytes) => {
    await accepts(); answer(bytes);
    await expect(read(await receiptFor(bytes))).rejects.toMatchObject({ reason: 'content' });
  });
  it('R10 checks exact bytes, not equivalent parsed JSON', async () => {
    const receipt = await accepts();
    const reordered = bytesOf({ timescale: table.timescale, schemaVersion: 1, runs: table.runs });
    expect(reordered.length).toBe(receipt.size); answer(reordered);
    await expect(read(receipt)).rejects.toMatchObject({ reason: 'digest' });
  });
  it('R11 refuses a short body independently of Content-Length', async () => {
    const receipt = await accepts(); answer(bytesOf(table).slice(0, -1));
    await expect(read(receipt)).rejects.toMatchObject({ reason: 'size' });
  });
  it('R12 cancels a stream exceeding measured bytes and returns no prefix', async () => {
    const receipt = await accepts(); const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(receipt.size + 1)); }, cancel }), { headers: { 'content-type': 'application/json' } }));
    await expect(read(receipt)).rejects.toBeInstanceOf(BodyTooLarge); expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([['status', 404, 'application/json'], ['content_type', 200, 'text/plain']] as const)('R13 cancels unread body on %s', async (reason, status, type) => {
    const receipt = await accepts(); const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status, headers: { 'content-type': type } }));
    await expect(read(receipt)).rejects.toMatchObject({ reason }); expect(cancel).toHaveBeenCalledOnce();
  });
  it('R14 refuses an elapsed deadline before GET', async () => {
    const receipt = await accepts();
    await expect(api.readVideoPresentationTable(receipt, policy, { deadlineAt: now })).rejects.toBeInstanceOf(DeadlinePassed);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('R15 headers consume the same deadline and unread body is cancelled', async () => {
    const receipt = await accepts(); const cancel = vi.fn();
    fetchMock.mockImplementationOnce(async () => { now += 1000; return new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } }); });
    await expect(read(receipt)).rejects.toBeInstanceOf(DeadlinePassed); expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['deadline', 'abort'] as const)('R16 no table escapes when %s occurs during digest', async (event) => {
    const receipt = await accepts(); answer(bytesOf(table)); const controller = new AbortController();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => { const value = await digest(algorithm, bytes); if (event === 'deadline') now += 1000; else controller.abort(new Error('left')); return value; });
    const pending = read(receipt, controller.signal);
    if (event === 'deadline') await expect(pending).rejects.toBeInstanceOf(DeadlinePassed);
    else await expect(pending).rejects.toThrow('left');
  });
  it('R17 cancellation stops an in-flight header request', async () => {
    const receipt = await accepts(); const controller = new AbortController();
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)); }));
    const pending = read(receipt, controller.signal); const observed = expect(pending).rejects.toThrow('left');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce()); controller.abort(new Error('left')); await observed;
  });
  it('R19 the remaining deadline cancels an unfinished body', async () => {
    const receipt = await accepts(); const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(bytesOf(table).slice(0, 10)); }, cancel }), { headers: { 'content-type': 'application/json' } }));
    await expect(api.readVideoPresentationTable(receipt, policy, { deadlineAt: now + 40 })).rejects.toBeInstanceOf(DeadlinePassed);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('R20 an already aborted caller does not GET', async () => {
    const receipt = await accepts(); const controller = new AbortController(); controller.abort(new Error('left'));
    await expect(read(receipt, controller.signal)).rejects.toThrow('left'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('R18 cancellation stops the body, without returning a partial table', async () => {
    const receipt = await accepts(); const controller = new AbortController(); const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(bytesOf(table).slice(0, 10)); }, cancel }), { headers: { 'content-type': 'application/json' } }));
    const pending = read(receipt, controller.signal); const observed = expect(pending).rejects.toThrow('left');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce()); controller.abort(new Error('left')); await observed; expect(cancel).toHaveBeenCalledOnce();
  });
});
