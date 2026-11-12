// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Uploading a file into an existing canvas node, the picker and Retry path
 * lifted out of `CanvasSpace` so a 3D capture can use it too (#1411 design
 * 5.3): the same gates, marks, reports and toasts, and an outcome the caller
 * can read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const h = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
  fetchUploadConfig: vi.fn(),
  requestUploadTicket: vi.fn(),
  reportNodeTaskFailure: vi.fn(),
  hashFile: vi.fn(),
  sendFileAndFinish: vi.fn(),
  waitForUploadEnding: vi.fn(),
}));
vi.mock('@web/lib/toast', () => ({ toast: h.toast }));
vi.mock('@web/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/api')>();
  return {
    ...actual,
    assetsApi: { ...actual.assetsApi, fetchUploadConfig: h.fetchUploadConfig, requestUploadTicket: h.requestUploadTicket },
    canvasApi: { ...actual.canvasApi, reportNodeTaskFailure: h.reportNodeTaskFailure },
  };
});
vi.mock('@web/data/upload/hash', () => ({ hashFile: h.hashFile }));
vi.mock('@web/data/upload/finish-upload', async (importOriginal) => ({
  ...await importOriginal<typeof import('@web/data/upload/finish-upload')>(),
  sendFileAndFinish: h.sendFileAndFinish,
}));
vi.mock('@web/data/upload/upload-status', async (importOriginal) => ({
  ...await importOriginal<typeof import('@web/data/upload/upload-status')>(),
  waitForUploadEnding: h.waitForUploadEnding,
}));

import { BytesNotDelivered } from '@web/data/upload/finish-upload';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { getRetryUpload } from '@web/spaces/canvas/upload-retry-files';
import { uploadIntoNode } from '@web/spaces/canvas/upload-into-node';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { useUploadMarksStore } from '@web/stores/upload-marks';

const TARGET = { projectId: 'p1', spaceId: 's1', nodeId: 'n1' };
const FILE = new File(['png'], '3D-Room.png', { type: 'image/png' });
const CFG = { maxUploadBytes: 2147483648, clientMaxAttempts: 1, clientRetryBaseDelayMs: 1, uploadIdleTimeoutMs: 60000 };
const TICKET = { uploadId: 'u1', token: 't1', storageKey: 'image/k.png', uploadUrl: 'https://ingest.example.test', kind: 'image', partSize: 5242880, totalParts: 1, taskId: 'task-1' };

/**
 * Put an empty image node on the canvas document.
 * @param locked - Whether it is locked.
 */
function placeNode(locked = false): void {
  const doc = getDoc(docName.canvasSpace(TARGET.projectId, TARGET.spaceId));
  const data = new Y.Map<unknown>();
  data.set('locked', locked);
  const node = new Y.Map<unknown>();
  node.set('type', 'image');
  node.set('data', data);
  doc.getMap('nodesMap').set(TARGET.nodeId, node);
}

const mark = (): unknown => useUploadMarksStore.getState().markOf(TARGET.spaceId, TARGET.nodeId);
const busy = (): boolean => useSpaceOperationsStore.getState().hasOperations(TARGET.spaceId);

beforeEach(() => {
  vi.clearAllMocks();
  useUploadMarksStore.setState({ marks: {} });
  h.fetchUploadConfig.mockResolvedValue(CFG);
  h.hashFile.mockResolvedValue('a'.repeat(64));
  h.requestUploadTicket.mockResolvedValue(TICKET);
  h.sendFileAndFinish.mockResolvedValue({ storageKey: TICKET.storageKey });
  h.waitForUploadEnding.mockResolvedValue({ key: TICKET.storageKey, state: 'completed', result: { assetId: 'a1', fileUrl: 'https://cdn/k.png', kind: 'image', width: 2048, height: 1152 } });
  h.reportNodeTaskFailure.mockResolvedValue({});
  placeNode();
});
afterEach(() => { _resetForTests(); });

describe('uploadIntoNode', () => {
  it('reports uploaded once the server registered the bytes, and holds the leave guard while sending', async () => {
    let busyWhileSending = false;
    h.sendFileAndFinish.mockImplementation(async () => { busyWhileSending = busy(); return { storageKey: TICKET.storageKey }; });
    await expect(uploadIntoNode(TARGET, FILE)).resolves.toEqual({ status: 'uploaded' });
    expect(h.requestUploadTicket).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', spaceId: 's1', nodeId: 'n1' }), undefined);
    expect(busyWhileSending).toBe(true);
    expect(busy()).toBe(false);
    expect(mark()).toBeUndefined();
  });

  it('refuses a locked node with the node-gate warning and sends nothing', async () => {
    placeNode(true);
    await expect(uploadIntoNode(TARGET, FILE)).resolves.toEqual({ status: 'failed', toasted: true });
    expect(h.toast.warning).toHaveBeenCalledOnce();
    expect(h.requestUploadTicket).not.toHaveBeenCalled();
  });

  it('says a refusal before the server answered on the node only', async () => {
    h.requestUploadTicket.mockRejectedValue(new Error('403'));
    await expect(uploadIntoNode(TARGET, FILE)).resolves.toEqual({ status: 'failed', toasted: false });
    expect(mark()).toMatchObject({ state: 'failed' });
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.toast.warning).not.toHaveBeenCalled();
  });

  it('says a file over the upload cap on the node only', async () => {
    h.fetchUploadConfig.mockResolvedValue({ ...CFG, maxUploadBytes: 1 });
    await expect(uploadIntoNode(TARGET, FILE)).resolves.toEqual({ status: 'failed', toasted: false });
    expect(mark()).toMatchObject({ state: 'failed', message: { key: 'canvas.upload.tooLarge' } });
    expect(h.requestUploadTicket).not.toHaveBeenCalled();
  });

  it('reports bytes that never reached the edge to the server and keeps the file for Retry', async () => {
    h.sendFileAndFinish.mockRejectedValue(new BytesNotDelivered(new Error('offline')));
    await expect(uploadIntoNode(TARGET, FILE)).resolves.toEqual({ status: 'failed', toasted: false });
    expect(h.reportNodeTaskFailure).toHaveBeenCalledWith('task-1');
    expect(getRetryUpload('p1', 's1', 'task-1')?.file).toBe(FILE);
  });

  it('toasts a finish the server recorded as failed, and says so in the outcome', async () => {
    h.waitForUploadEnding.mockResolvedValue({ key: TICKET.storageKey, state: 'failed', reason: 'storage_error' });
    await expect(uploadIntoNode(TARGET, FILE)).resolves.toEqual({ status: 'failed', toasted: true });
    expect(h.toast.error).toHaveBeenCalledOnce();
  });
});
