// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A mini-tool run refused with 413 (inner#1006 design §5, test spec §7.4
 * E05, E06 and the mini-tool entry of E10): the nodes it built say the request
 * was too large. A sentence our server wrote is shown as it is; nginx's 413
 * carries none, so the nodes get the same key Generate uses, with the limit
 * from the session's cached upload config (2 MiB here, not the default).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { miniToolById, type MiniToolSnapshot, type MiniToolSpec } from '@breatic/shared/mini-tools';
import type * as RequestModule from '@web/data/api/request';

const canvas = vi.hoisted(() => ({
  addNode: vi.fn(),
  addEdge: vi.fn((_p: string, _s: string, _edge: { source: string; toolId?: string }) => true),
  runCanvasUndoBatch: vi.fn((_p: string, _s: string, body: () => void) => body()),
  createGroup: vi.fn(),
}));
vi.mock('@web/data/yjs/canvas-space', () => canvas);
const api = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@web/data/api/mini-tools', () => ({ miniToolsApi: api }));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  apiGet: vi.fn(),
}));

import { apiGet } from '@web/data/api/request';
import { assetsApi } from '@web/data/api/assets';
import { ApiException } from '@web/data/api/types';
import { startMiniToolRun, type MiniToolRun } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useUploadMarksStore, type UploadMark } from '@web/stores/upload-marks';

const SPACE = '22222222-2222-4222-8222-222222222222';
const SERVER_SENTENCE = 'This request is larger than 1 MiB. Shorten the prompt or the text it refers to.';

/**
 * Make the session's cached upload config name this request-body limit.
 * @param maxRequestBodyBytes - The limit; undefined leaves the field out.
 * @returns Once the config is cached.
 */
async function cacheLimit(maxRequestBodyBytes: number | undefined): Promise<void> {
  assetsApi.resetUploadConfigCache();
  vi.mocked(apiGet).mockResolvedValue({
    maxUploadBytes: 2 * 1024 * 1024 * 1024,
    clientMaxAttempts: 3,
    clientRetryBaseDelayMs: 1,
    uploadIdleTimeoutMs: 30_000,
    assetUrlPrefix: 'https://assets.test.invalid/',
    uploadStatusPollSeconds: 1,
    ...(maxRequestBodyBytes !== undefined && { maxRequestBodyBytes }),
  });
  await assetsApi.fetchUploadConfig();
}

/**
 * The marks on the nodes this press built, in build order.
 * @returns Each node's mark.
 */
function marksOfBuilt(): (UploadMark | undefined)[] {
  const ids = canvas.addNode.mock.calls.map((call) => (call[2] as { id: string }).id);
  return ids.map((id) => useUploadMarksStore.getState().markOf(SPACE, id));
}

/**
 * The failure message on every built node; fails unless all carry the same one.
 * @returns That message.
 */
function failedMessage(): unknown {
  const marks = marksOfBuilt();
  expect(marks).toHaveLength(2);
  const messages = marks.map((mark) => (mark?.state === 'failed' ? mark.message : mark?.state));
  expect(messages[1]).toEqual(messages[0]);
  return messages[0];
}

/**
 * A registry tool by id.
 * @param id - The tool id.
 * @returns The declaration.
 */
function tool(id: string): MiniToolSpec {
  const spec = miniToolById(id);
  if (!spec) throw new Error(id);
  return spec;
}

const SNAPSHOT: MiniToolSnapshot = {
  params: {},
  prompt: '',
  source: { url: 'https://cdn/a.mp3', duration: 12 },
  slots: {},
};

/**
 * A server tool's press on an audio node.
 * @returns The run.
 */
function press(): MiniToolRun {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    spaceId: SPACE,
    userId: 'u1',
    spec: tool('audio.separate'),
    snapshot: SNAPSHOT,
    source: {
      id: 'src',
      name: 'SONG',
      position: { x: 100, y: 50 },
      groupOrigin: null,
      mimeType: 'audio/mpeg',
    },
    sourceExists: () => true,
    exportFile: vi.fn(),
    fillUpload: vi.fn(),
    fillUploads: vi.fn(),
    exportDrawing: vi.fn(),
    exportExpand: vi.fn(),
    uploadImage: vi.fn(),
    setExporting: vi.fn(),
    stillOpen: () => true,
    onBuilt: vi.fn(),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetRunOnceForTests();
  useUploadMarksStore.setState({ marks: {} });
  await cacheLimit(2097152);
});

describe('a mini-tool run refused with 413', () => {
  it('E05 nginx\'s 413: the nodes say the server\'s payload_too_large sentence with the configured limit', async () => {
    api.run.mockRejectedValue(new ApiException({ status: 413, message: '<html>413</html>', fromServer: false }));

    await startMiniToolRun(press());

    expect(failedMessage()).toEqual({
      key: 'server.error.payload_too_large',
      params: { limit: '2 MiB' },
    });
  });

  it('E06 our server\'s 413: the nodes show its sentence', async () => {
    api.run.mockRejectedValue(new ApiException({ status: 413, message: SERVER_SENTENCE, fromServer: true }));

    await startMiniToolRun(press());

    expect(failedMessage()).toEqual({ text: SERVER_SENTENCE });
  });

  it.each([
    ['no config fetched yet', null],
    ['a config without the field', undefined],
  ])('E10 nginx\'s 413 with %s: the limitless key, not couldNotStart', async (_case, limit) => {
    if (limit === null) assetsApi.resetUploadConfigCache();
    else await cacheLimit(limit);
    api.run.mockRejectedValue(new ApiException({ status: 413, message: '<html>413</html>', fromServer: false }));

    await startMiniToolRun(press());

    const message = failedMessage() as { key?: string; params?: Record<string, unknown> };
    expect(message.key).toBe('canvas.generatePanel.errorTooLargeNoLimit');
    expect(message.params?.limit).toBeUndefined();
  });
});
