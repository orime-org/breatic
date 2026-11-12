// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Adding a 3D capture to the Agent tray (#1411 design 3.4 and 5.2): every way
 * it stops says what the tray says for a picked file and adds nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openTray: vi.fn(),
  uploadTrayItem: vi.fn(),
  add: vi.fn(),
  say: vi.fn(),
  maxUploadBytes: 1 << 30,
}));
vi.mock('@web/stores/attach-to-chat', () => ({ openTray: h.openTray, uploadTrayItem: h.uploadTrayItem }));
vi.mock('@web/stores/chat-attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/stores/chat-attachments')>();
  return { ...actual, chatAttachments: { ...actual.chatAttachments, add: h.add, say: h.say } };
});
vi.mock('@web/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/api')>();
  return { ...actual, assetsApi: { ...actual.assetsApi, fetchUploadConfig: vi.fn(async () => ({ maxUploadBytes: h.maxUploadBytes })) } };
});
vi.mock('@web/spaces/canvas/upload-derived-image', () => ({ uploadDerivedImage: vi.fn(async () => 'https://cdn.example.test/shot.png') }));

const { sendCaptureToAgent } = await import('@web/spaces/three-d/viewfinder/viewfinder-send');
const { useUIStore } = await import('@web/stores/ui');

const WHERE = { projectId: 'p1', spaceId: 's1' };
const FILE = new File(['png-bytes'], '3D-Room.png', { type: 'image/png' });
const TRAY = { conversationId: 'c1', limits: { maxItems: 5, maxChars: 1000 } };

beforeEach(() => {
  vi.clearAllMocks();
  h.maxUploadBytes = 1 << 30;
  h.openTray.mockResolvedValue(TRAY);
  h.add.mockReturnValue('added');
  h.uploadTrayItem.mockResolvedValue('ready');
  useUIStore.getState().setChatPanelCollapsed(true);
});

describe('sendCaptureToAgent', () => {
  it('brings the chat column into view and adds the still uploading, then ready', async () => {
    await expect(sendCaptureToAgent(WHERE, FILE)).resolves.toBe(true);
    expect(useUIStore.getState().chatPanelCollapsed).toBe(false);
    expect(h.add).toHaveBeenCalledWith('c1', [expect.objectContaining({ name: '3D-Room.png', type: 'image', status: 'uploading' })], TRAY.limits);
    expect(h.uploadTrayItem).toHaveBeenCalledOnce();
  });

  it('adds nothing when no conversation could be opened', async () => {
    h.openTray.mockResolvedValue(undefined);
    await expect(sendCaptureToAgent(WHERE, FILE)).resolves.toBe(false);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('says the file is too large, as the tray does, and adds nothing', async () => {
    h.maxUploadBytes = 1;
    await expect(sendCaptureToAgent(WHERE, FILE)).resolves.toBe(false);
    expect(h.say).toHaveBeenCalledWith({ key: 'tooLarge', filename: '3D-Room.png' });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('uploads nothing when the tray refuses the item', async () => {
    h.add.mockReturnValue('full');
    await expect(sendCaptureToAgent(WHERE, FILE)).resolves.toBe(false);
    expect(h.uploadTrayItem).not.toHaveBeenCalled();
  });

  it('says the format was refused when the server turns the upload away', async () => {
    h.uploadTrayItem.mockResolvedValue('unsupported');
    await expect(sendCaptureToAgent(WHERE, FILE)).resolves.toBe(false);
    expect(h.say).toHaveBeenCalledWith(expect.objectContaining({ key: 'unsupportedMedia', filename: '3D-Room.png' }));
  });
});
