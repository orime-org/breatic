// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A message the server refuses for its shape is checked against the live
 * build before the panel says anything about it, so an out-of-date page has
 * silenced the panel's toast by the time the send settles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AssetsApiModule from '@web/data/api/assets';

// Chat sends every body through bodyOrTransfer, which first asks for the
// upload config. Answer it here with the shipped request-body limit, so the
// real threshold runs (these bodies are small and go as they are) and no
// request reaches the network, where fake timers would never settle it.
vi.mock('@web/data/api/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof AssetsApiModule>();
  return {
    ...actual,
    assetsApi: {
      ...actual.assetsApi,
      fetchUploadConfig: async () => ({
        maxUploadBytes: 2 * 1024 * 1024 * 1024,
        clientMaxAttempts: 3,
        clientRetryBaseDelayMs: 1000,
        uploadIdleTimeoutMs: 30_000,
        assetUrlPrefix: 'https://assets.test.invalid/',
        uploadStatusPollSeconds: 5,
        maxRequestBodyBytes: 1048576,
      }),
    },
  };
});

const order: string[] = [];
const checkStaleRelease = vi.hoisted(() => vi.fn());
vi.mock('@web/data/deployment/stale-release', () => ({ checkStaleRelease }));

const { AxiosError } = await import('axios');
const { request } = await import('@web/data/api/request');
const { chatSessionFor, evictAllChatSessions } = await import('@web/stores/chat-sessions');
const { chatLive, resetChatLiveForTests } = await import('@web/stores/chat-live');
const { resetRunOnceForTests } = await import('@web/stores/task-actions-in-flight');
const { watchChatMishaps } = await import('@web/stores/chat-mishaps');

const originalAdapter = request.defaults.adapter;
let stopWatching = (): void => undefined;

/**
 * Answer every request through axios with an error envelope, so the send
 * meets the response interceptor that checks the build.
 * @param error - The envelope's `error` object.
 */
function refuseWith(error: Record<string, unknown>): void {
  request.defaults.adapter = (config) =>
    Promise.reject(
      new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, {
        status: Number(error.code),
        statusText: 'Unprocessable Entity',
        headers: {},
        config,
        data: { error },
      }),
    );
}

/**
 * Send "hello" to c-1.
 * @returns How the send ended.
 */
function send(): ReturnType<typeof chatLive.send> {
  return chatLive.send({ projectId: 'p-1', conversationId: 'c-1', words: 'hello', chips: [], spaces: {} });
}

beforeEach(() => {
  evictAllChatSessions();
  order.length = 0;
  checkStaleRelease.mockReset().mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push('checked');
    return true;
  });
  stopWatching = watchChatMishaps(() => order.push('told'));
  chatSessionFor({
    projectId: 'p-1',
    conversationId: 'c-1',
    history: [],
    onTitled: () => undefined,
  });
});

afterEach(() => {
  stopWatching();
  request.defaults.adapter = originalAdapter;
  resetChatLiveForTests();
  resetRunOnceForTests();
  evictAllChatSessions();
  vi.restoreAllMocks();
});

describe('a refused message on a page that may be out of date', () => {
  it('checks the build with the mark the server set, before telling the user', async () => {
    refuseWith({ code: 422, message: 'Invalid input', reason: 'request_shape' });
    await send();
    await vi.waitFor(() => expect(order).toContain('told'));
    expect(checkStaleRelease).toHaveBeenCalledWith('request_shape');
    expect(order).toEqual(['checked', 'told']);
  });

  it('hands a business refusal to the check unmarked', async () => {
    refuseWith({ code: 422, message: 'Message too long' });
    await send();
    await vi.waitFor(() => expect(order).toContain('told'));
    expect(checkStaleRelease).toHaveBeenCalledWith(undefined);
  });
});
