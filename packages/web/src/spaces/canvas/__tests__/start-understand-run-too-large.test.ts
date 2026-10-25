// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Understand and Transcribe refused with 413 (inner#1006 design §5, test
 * spec §7.4 E07-E09 and the reading entry of E10). Our server's 413 carries
 * its own sentence and is shown as it is; nginx's carries none, so the press
 * says the server's payload_too_large sentence with the limit from the session's cached upload config
 * (2 MiB here, not the default) instead of "could not start".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale, t } from '@breatic/shared';
import type * as RequestModule from '@web/data/api/request';

vi.mock('@web/data/yjs/canvas-space', () => ({
  addNode: vi.fn(() => true),
  addEdge: vi.fn(() => true),
  runCanvasUndoBatch: vi.fn((_p: string, _s: string, run: () => void) => {
    run();
  }),
}));
vi.mock('@web/data/api/canvas', () => ({
  canvasApi: {
    understand: vi.fn(async () => ({ task_id: 't-1', status: 'pending' })),
    transcribe: vi.fn(async () => ({ task_id: 't-2', status: 'pending' })),
  },
  getCachedUnderstandMaxBytes: vi.fn(() => 20 * 1024 * 1024),
}));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn() },
}));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  apiGet: vi.fn(),
}));

import { apiGet } from '@web/data/api/request';
import { assetsApi } from '@web/data/api/assets';
import { canvasApi } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';
import { startTranscribeRun, startUnderstandRun } from '@web/spaces/canvas/start-understand-run';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';

const SERVER_SENTENCE = 'This request is larger than 1 MiB. Shorten the prompt or the text it refers to.';
const NGINX_413 = (): ApiException =>
  new ApiException({ status: 413, message: '<html>413 Request Entity Too Large</html>', fromServer: false });

const RUN = {
  projectId: 'p-1',
  spaceId: 's-1',
  userId: 'u-1',
  onBuilt: (): void => {},
  source: {
    id: 'n-1',
    name: 'dog',
    kind: 'image' as const,
    url: 'https://assets.invalid/image/a.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    position: { x: 100, y: 40 },
    groupOrigin: null,
  },
};
const AUDIO = {
  ...RUN.source,
  name: 'meeting',
  kind: 'audio' as const,
  url: 'https://assets.invalid/audio/a.m4a',
  mimeType: 'audio/mp4',
};

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

beforeEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  resetRunOnceForTests();
  await cacheLimit(2097152);
});

describe('a reading refused with 413', () => {
  afterEach(() => {
    setLocale('en');
  });

  it('E07 Understand, nginx\'s 413: the server\'s payload_too_large sentence with the configured limit', async () => {
    // zh-CN words this sentence apart from the old Generate copy, which
    // English does not.
    setLocale('zh-CN');
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(NGINX_413());

    await startUnderstandRun(RUN);

    const expected = t('server.error.payload_too_large', { limit: '2 MiB' });
    expect(vi.mocked(toast.error).mock.calls).toEqual([[expected]]);
    expect(expected).toContain('2 MiB');
    expect(expected).not.toBe(t('canvas.understand.couldNotStart'));
  });

  it('E08 Transcribe, nginx\'s 413: the server\'s payload_too_large sentence with the configured limit', async () => {
    // zh-CN words this sentence apart from the old Generate copy, which
    // English does not.
    setLocale('zh-CN');
    vi.mocked(canvasApi.transcribe).mockRejectedValueOnce(NGINX_413());

    await startTranscribeRun({ ...RUN, source: AUDIO, keepFillers: false });

    const expected = t('server.error.payload_too_large', { limit: '2 MiB' });
    expect(vi.mocked(toast.error).mock.calls).toEqual([[expected]]);
    expect(expected).toContain('2 MiB');
    expect(expected).not.toBe(t('canvas.transcribe.couldNotStart'));
  });

  it('E09 our server\'s 413: its own sentence', async () => {
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(
      new ApiException({ status: 413, message: SERVER_SENTENCE, fromServer: true }),
    );

    await startUnderstandRun(RUN);

    expect(vi.mocked(toast.error).mock.calls).toEqual([[SERVER_SENTENCE]]);
  });

  it('nginx\'s 413 before the config was cached: fetches it and names its limit', async () => {
    await cacheLimit(2097152);
    assetsApi.resetUploadConfigCache();
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(NGINX_413());

    await startUnderstandRun(RUN);

    expect(vi.mocked(apiGet)).toHaveBeenLastCalledWith('/assets/upload-config');
    expect(vi.mocked(toast.error).mock.calls).toEqual([[t('server.error.payload_too_large', { limit: '2 MiB' })]]);
  });

  it.each([
    ['a config that cannot be fetched', null],
    ['a config without the field', undefined],
  ])('E10 nginx\'s 413 with %s: the limitless sentence, not couldNotStart', async (_case, limit) => {
    if (limit === null) {
      assetsApi.resetUploadConfigCache();
      vi.mocked(apiGet).mockRejectedValue(new Error('offline'));
    } else await cacheLimit(limit);
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(NGINX_413());

    await startUnderstandRun(RUN);

    const expected = t('canvas.generatePanel.errorTooLargeNoLimit');
    expect(expected).not.toBe('canvas.generatePanel.errorTooLargeNoLimit');
    expect(vi.mocked(toast.error).mock.calls).toEqual([[expected]]);
    expect(expected).not.toContain('{limit}');
    expect(expected).not.toContain('undefined');
  });
});
