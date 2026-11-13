// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const { uploadTrayItem } = await import('@web/stores/attach-to-chat');
const { chatAttachments } = await import('@web/stores/chat-attachments');
const { UploadFailedError } = await import('@web/data/upload/media-upload');
import type { TrayItem } from '@web/stores/chat-attachments';

const TRAY = { conversationId: 'c-upload', limits: { maxItems: 5, maxChars: 200_000 } };
const FILE = new File(['png'], '3D shot.png', { type: 'image/png' });
const ITEM: TrayItem = { id: 'shot-1', name: '3D shot.png', type: 'image', status: 'uploading' };

beforeEach(() => {
  chatAttachments.forget([TRAY.conversationId]);
  expect(chatAttachments.add(TRAY.conversationId, [ITEM], TRAY.limits)).toBe('added');
});

/**
 * The one item in the tray.
 * @returns It.
 */
function item(): TrayItem | undefined {
  return chatAttachments.trayOf(TRAY.conversationId)[0];
}

describe('uploading one item already in the tray (#1411 design 5.2)', () => {
  it('settles it ready with the uploaded url', async () => {
    const upload = vi.fn(async () => 'https://assets.example.test/shot.png');
    await expect(uploadTrayItem(TRAY, ITEM, FILE, upload)).resolves.toBe('ready');
    expect(upload).toHaveBeenCalledWith(FILE);
    expect(item()).toMatchObject({ status: 'ready', chip: { id: 'shot-1', type: 'image', name: '3D shot.png', data_snapshot: { url: 'https://assets.example.test/shot.png' } } });
  });

  it('marks it failed when the upload fails', async () => {
    await expect(uploadTrayItem(TRAY, ITEM, FILE, async () => { throw new UploadFailedError('transfer'); })).resolves.toBe('failed');
    expect(item()).toMatchObject({ status: 'failed', failure: 'upload' });
  });

  it('marks it rate limited when the upload was refused for coming too often', async () => {
    await expect(uploadTrayItem(TRAY, ITEM, FILE, async () => { throw new UploadFailedError('rateLimited'); })).resolves.toBe('rate_limited');
    expect(item()).toMatchObject({ status: 'failed', failure: 'rate_limited' });
  });

  it('says the format was refused and marks it failed', async () => {
    await expect(uploadTrayItem(TRAY, ITEM, FILE, async () => { throw new UploadFailedError('unsupportedType'); })).resolves.toBe('unsupported');
    expect(item()).toMatchObject({ status: 'failed', failure: 'upload' });
  });

  it('reports failed when the user removed the item while it was uploading', async () => {
    const upload = vi.fn(async () => { chatAttachments.remove(TRAY.conversationId, ITEM.id); return 'https://assets.example.test/shot.png'; });
    await expect(uploadTrayItem(TRAY, ITEM, FILE, upload)).resolves.toBe('failed');
    expect(item()).toBeUndefined();
  });
});
