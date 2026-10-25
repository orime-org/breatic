// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Generate press refused with 413 says the request was too large and by how
 * much it may be (inner#1006 design §5, test spec §7.4 E01-E04 and the
 * Generate entry of E10).
 *
 * The limit is the server's `maxRequestBodyBytes`, read synchronously from the
 * session's cached upload config. The config here names 2 MiB rather than the
 * default 1 MiB, so a sentence that says "2 MiB" can only have come from it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale, t, type TaskCreateInput } from '@breatic/shared';
import type * as RequestModule from '@web/data/api/request';

vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  apiGet: vi.fn(),
}));
vi.mock('@web/data/api/canvas', () => ({
  canvasApi: { createTask: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { apiGet } from '@web/data/api/request';
import { assetsApi } from '@web/data/api/assets';
import { canvasApi } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';
import { canvasSessions } from '@web/stores/canvas-session';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';
import { submitGeneration } from '@web/spaces/canvas/generate/submit-generation';

const TWO_MIB = 2097152;
const SERVER_SENTENCE = 'This request is larger than 1 MiB. Shorten the prompt or the text it refers to.';

/**
 * Make the session's cached upload config name this request-body limit.
 * @param maxRequestBodyBytes - The limit, as the server sends it; undefined leaves the field out.
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
 * Let pending promise callbacks run.
 * @returns Once they have.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Press Generate on node n and let the refusal come back.
 * @returns Once the failure has been said.
 */
async function pressAndFail(): Promise<void> {
  submitGeneration({
    spaceId: 's',
    nodeId: 'n',
    panelKind: 'generate',
    buildPayload: () => ({}) as TaskCreateInput,
  });
  await flush();
  await flush();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cacheLimit(TWO_MIB);
});

afterEach(() => {
  setLocale('en');
  resetRunOnceForTests();
  canvasSessions.clear();
  assetsApi.resetUploadConfigCache();
});

describe('executeErrorMessage on 413 (E01, E02)', () => {
  it('E01 asks for the server\'s payload_too_large sentence with the configured limit, and returns what it got', () => {
    const translate = vi.fn((key: string, params?: Record<string, string | number>) =>
      `${key}:${JSON.stringify(params)}`,
    );

    const message = executeErrorMessage(413, translate);

    expect(translate.mock.calls).toEqual([['server.error.payload_too_large', { limit: '2 MiB' }]]);
    expect(message).toBe('server.error.payload_too_large:{"limit":"2 MiB"}');
  });

  it.each([
    [402, 'canvas.generatePanel.errorCredits'],
    [507, 'canvas.generatePanel.errorStorageFull'],
    [503, 'canvas.generatePanel.errorUnavailable'],
    [500, 'canvas.generatePanel.errorFailed'],
    [undefined, 'canvas.generatePanel.errorFailed'],
  ])('E02 keeps the sentence for %s', (status, key) => {
    expect(executeErrorMessage(status, (k: string) => k)).toBe(key);
  });
});

describe('executeErrorMessage on 413 without a usable limit (E10, Generate entry)', () => {
  it.each([
    ['no config fetched yet', null],
    ['a config without the field', undefined],
  ])('says the limitless sentence when there is %s', async (_case, limit) => {
    if (limit === null) assetsApi.resetUploadConfigCache();
    else await cacheLimit(limit);

    const message = executeErrorMessage(413, t);

    expect(message).toBe(t('canvas.generatePanel.errorTooLargeNoLimit'));
    expect(message).not.toBe('canvas.generatePanel.errorTooLargeNoLimit');
    expect(message).not.toContain('{limit}');
    expect(message).not.toContain('undefined');
    expect(message).not.toBe(t('canvas.generatePanel.errorFailed'));
  });
});

describe('a Generate press refused with 413 (E03, E04)', () => {
  it.each([
    ['nginx, with no sentence of ours', new ApiException({ status: 413, message: '<html>413</html>', fromServer: false })],
    ['our server, with its own sentence', new ApiException({ status: 413, message: SERVER_SENTENCE, fromServer: true })],
  ])('says the server\'s payload_too_large sentence with the configured limit when refused by %s', async (_case, refusal) => {
    // Read in zh-CN, where this sentence is worded apart from every other
    // one; in English the old Generate copy said the same words.
    setLocale('zh-CN');
    vi.mocked(canvasApi.createTask).mockRejectedValueOnce(refusal);

    await pressAndFail();

    const expected = t('server.error.payload_too_large', { limit: '2 MiB' });
    expect(vi.mocked(toast.error).mock.calls).toEqual([[expected]]);
    expect(expected).toContain('2 MiB');
  });
});
