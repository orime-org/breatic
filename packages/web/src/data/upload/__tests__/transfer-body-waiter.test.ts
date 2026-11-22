// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A transfer body is waited for from its ticket on (#1580, test spec J-04, J-06; design §3), with the page's real
 * table: an ending that arrives before the finish request answers is still the transfer's ending, and a finish that
 * fails takes the registration back. Only the network is stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SharedModule from '@breatic/shared';
import type * as RequestModule from '@web/data/api/request';

vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));
vi.mock('@breatic/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModule>()),
  sendBytesToIngest: vi.fn(),
}));

import { sendBytesToIngest } from '@breatic/shared';
import { apiGet, apiPost } from '@web/data/api/request';
import { assetsApi } from '@web/data/api/assets';
import { bodyOrTransfer } from '@web/data/upload/transfer-body';
import { settleUploadEnding, waitingUploadKeys } from '@web/data/upload/upload-status';

const P = '11111111-1111-4111-8111-111111111111';
const LIMIT = 1024;

let n = 0;
let key = '';

/**
 * A body one byte over the limit.
 * @returns The body.
 */
function big(): Record<string, string> {
  return { t: 'a'.repeat(LIMIT) };
}

beforeEach(() => {
  vi.clearAllMocks();
  n += 1;
  key = `transfer/2026-11-22/${n}_00000000-0000-4000-8000-00000000000${n % 10}.transfer`;
  assetsApi.resetUploadConfigCache();
  vi.mocked(apiGet).mockImplementation(async (url: string) => {
    if (url !== '/assets/upload-config') throw new Error(`unexpected GET ${url}`);
    return {
      maxUploadBytes: 2 * 1024 * 1024 * 1024, clientMaxAttempts: 3, clientRetryBaseDelayMs: 1,
      uploadIdleTimeoutMs: 30_000, assetUrlPrefix: 'https://assets.test.invalid/', maxRequestBodyBytes: LIMIT,
    };
  });
  vi.mocked(sendBytesToIngest).mockResolvedValue({ uploadId: 'u', token: 't', parts: [{ partNumber: 1, etag: 'e' }] });
});

afterEach(() => {
  assetsApi.resetUploadConfigCache();
});

/**
 * Serve the ticket, and the finish through `finish`.
 * @param finish - What the finish request does.
 */
function serve(finish: () => Promise<unknown>): void {
  vi.mocked(apiPost).mockImplementation(async (url: string) => {
    if (url === '/assets/transfer-ticket') {
      return { uploadId: 'u', token: 't', storageKey: key, uploadUrl: 'https://ingest.test.invalid', kind: 'file', partSize: 8 * 1024 * 1024, totalParts: 1 };
    }
    if (/^\/assets\/uploads\/[^/]+\/complete$/.test(url)) return finish();
    throw new Error(`unexpected POST ${url}`);
  });
}

describe('a transfer body\'s wait', () => {
  it('J-04 an ending told before the finish request answers is the transfer\'s ending', async () => {
    serve(async () => {
      settleUploadEnding({ key, state: 'transferred' });
      return { storageKey: key };
    });
    await expect(bodyOrTransfer(P, big())).resolves.toEqual({ transfer: key });
  });

  it('J-06 a finish request that fails takes the registration back and throws as before', async () => {
    serve(async () => {
      throw new Error('finish refused');
    });
    await expect(bodyOrTransfer(P, big())).rejects.toThrow();
    expect(waitingUploadKeys()).not.toContain(key);
  });

  it('J-06 bytes that fail to send take the registration back', async () => {
    serve(async () => ({ storageKey: key }));
    vi.mocked(sendBytesToIngest).mockRejectedValue(new Error('network'));
    await expect(bodyOrTransfer(P, big())).rejects.toThrow();
    expect(waitingUploadKeys()).not.toContain(key);
  });
});
