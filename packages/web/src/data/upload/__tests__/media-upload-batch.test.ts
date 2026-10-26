// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';

import { ApiException } from '@web/data/api/types';
import { BytesNotDelivered } from '@web/data/upload/finish-upload';
import { runMediaUploadBatch, type BatchUploadEntry } from '@web/data/upload/media-upload';

const CFG = {
  maxUploadBytes: 2147483648,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 1000,
  uploadIdleTimeoutMs: 60000,
  uploadStatusPollSeconds: 2,
  assetUrlPrefix: 'https://cdn/',
};

const CONTEXT = {
  projectId: '11111111-1111-4111-8111-111111111111',
  spaceId: '22222222-2222-4222-9222-222222222222',
  source: 'mini_tool',
  toolName: 'image.grid',
} as const;

/**
 * A ticket for the file at `index`.
 * @param index - Its place in the batch.
 * @returns The ticket.
 */
function ticket(index: number): Record<string, unknown> {
  return {
    uploadId: `upload-${index}`,
    token: `token-${index}`,
    storageKey: `image/k${index}.png`,
    uploadUrl: 'https://ingest.example.com',
    kind: 'image',
    partSize: 5 * 1024 * 1024,
    totalParts: 1,
    taskId: `task-${index}`,
  };
}

/**
 * One tile's entry with spy sinks.
 * @param index - Its place in the batch.
 * @returns The entry.
 */
function entry(index: number): BatchUploadEntry {
  return {
    file: new File([new Uint8Array(4)], `GRID-${index}.png`, { type: 'image/png' }),
    nodeId: `node-${index}`,
    onAnswered: vi.fn(),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
  };
}

/**
 * Deps whose batch request answers a ticket per item unless told otherwise.
 * @param over - Fields to replace.
 * @returns The deps.
 */
function deps(over: Record<string, unknown> = {}): Parameters<typeof runMediaUploadBatch>[2] {
  return {
    getUploadConfig: vi.fn().mockResolvedValue(CFG),
    hashFile: vi.fn().mockImplementation(async (file: File) => file.name.padEnd(64, '0').slice(0, 64)),
    requestTicketBatch: vi
      .fn()
      .mockImplementation(async (req: { items: unknown[] }) => req.items.map((_, i) => ticket(i))),
    sendToIngest: vi.fn().mockImplementation(async (_file: File, t: { storageKey: string }) => ({
      storageKey: t.storageKey,
    })),
    waitForEnding: vi.fn().mockResolvedValue({ key: 'k', state: 'completed', result: {} }),
    sleep: () => Promise.resolve(),
    ...over,
  } as Parameters<typeof runMediaUploadBatch>[2];
}

describe('runMediaUploadBatch', () => {
  it('asks for every tile’s ticket in one request, in order, each on its node', async () => {
    const entries = Array.from({ length: 64 }, (_, i) => entry(i));
    const d = deps();

    await runMediaUploadBatch(entries, CONTEXT, d);

    expect(d.requestTicketBatch).toHaveBeenCalledTimes(1);
    const [request] = vi.mocked(d.requestTicketBatch).mock.calls[0]!;
    expect(request).toMatchObject(CONTEXT);
    expect(request.items.map((item) => item.nodeId)).toEqual(entries.map((e) => e.nodeId));
    expect(request.items[3]).toMatchObject({ filename: 'GRID-3.png', contentType: 'image/png', size: 4 });
    expect(d.sendToIngest).toHaveBeenCalledTimes(64);
  });

  it('sends a ticket, settles a hit and fails a refusal, each on its own entry', async () => {
    const entries = [entry(0), entry(1), entry(2), entry(3)];
    const d = deps({
      requestTicketBatch: vi.fn().mockResolvedValue([
        ticket(0),
        { alreadyExists: true, assetId: 'a1', fileUrl: 'https://cdn/a1.png', kind: 'image', width: 3, height: 3 },
        { refused: { reason: 'storage' } },
        { refused: { reason: 'too_large' } },
      ]),
    });

    await runMediaUploadBatch(entries, CONTEXT, d);

    expect(vi.mocked(d.sendToIngest).mock.calls.map(([file]) => file.name)).toEqual(['GRID-0.png']);
    expect(entries[1]!.onSuccess).toHaveBeenCalledWith({
      assetId: 'a1',
      fileUrl: 'https://cdn/a1.png',
      kind: 'image',
      width: 3,
      height: 3,
    });
    expect(entries[2]!.onFailure).toHaveBeenCalledWith({ reason: 'storage' });
    expect(entries[3]!.onFailure).toHaveBeenCalledWith({ reason: 'upload' });
    expect(entries[0]!.onFailure).not.toHaveBeenCalled();
    // inner#1303 §6.7: a ticket or a hit is the server's answer; a refusal is not.
    expect(entries.map((e) => vi.mocked(e.onAnswered!).mock.calls.length)).toEqual([1, 1, 0, 0]);
  });

  it('fails a tile the browser could not hash and leaves it out of the request', async () => {
    const entries = [entry(0), entry(1)];
    const d = deps({
      hashFile: vi.fn().mockImplementation(async (file: File) => (file.name === 'GRID-0.png' ? null : 'b'.repeat(64))),
    });

    await runMediaUploadBatch(entries, CONTEXT, d);

    expect(entries[0]!.onFailure).toHaveBeenCalledWith({ reason: 'hash' });
    const [request] = vi.mocked(d.requestTicketBatch).mock.calls[0]!;
    expect(request.items.map((item) => item.nodeId)).toEqual(['node-1']);
  });

  it('fails every tile with the reason the batch request ended in', async () => {
    const entries = [entry(0), entry(1)];
    const d = deps({
      requestTicketBatch: vi.fn().mockRejectedValue(new ApiException({ status: 429, message: 'slow down' })),
    });

    await runMediaUploadBatch(entries, CONTEXT, d);

    for (const e of entries) expect(e.onFailure).toHaveBeenCalledWith({ reason: 'rateLimited' });
  });

  it('keeps a tile’s task row on a transfer that fails', async () => {
    const entries = [entry(0)];
    const d = deps({ sendToIngest: vi.fn().mockRejectedValue(new BytesNotDelivered(new Error('down'))) });

    await runMediaUploadBatch(entries, CONTEXT, d);

    expect(entries[0]!.onFailure).toHaveBeenCalledWith({ reason: 'transfer', taskId: 'task-0' });
  });
});

// inner#1595 §3.4–§3.5: one file the server could not open at the ingest Worker
// fails on its own entry as a transfer naming its row; the others go on.
describe('runMediaUploadBatch — one file the server could not open (inner#1595)', () => {
  it('W04 fails only that entry, after its answer, and sends only the ticketed file', async () => {
    const entries = [entry(0), entry(1), entry(2), entry(3)];
    const d = deps({
      requestTicketBatch: vi.fn().mockResolvedValue([
        ticket(0),
        { openFailed: { reason: 'store_failed' }, taskId: 't2' },
        { alreadyExists: true, assetId: 'a2', fileUrl: 'https://cdn/a2.png', kind: 'image', width: 3, height: 3 },
        { refused: { reason: 'storage' } },
      ]),
    });

    await runMediaUploadBatch(entries, CONTEXT, d);

    expect(d.requestTicketBatch).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(d.sendToIngest).mock.calls;
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(entries[0]!.file);
    const e1 = entries[1]!;
    expect(e1.onAnswered).toHaveBeenCalledOnce();
    expect(e1.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'transfer', taskId: 't2' });
    expect(vi.mocked(e1.onAnswered!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(e1.onFailure).mock.invocationCallOrder[0]!,
    );
    expect(e1.onSuccess).not.toHaveBeenCalled();
    expect(entries[2]!.onSuccess).toHaveBeenCalledOnce();
    expect(entries[3]!.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'storage' });
    expect(entries[0]!.onFailure).not.toHaveBeenCalled();
  });
});
