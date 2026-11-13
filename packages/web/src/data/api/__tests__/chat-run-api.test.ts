// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the chat client asks of a conversation's run (inner#1717): sending a
 * message or a card's answer, asking where the conversation stands, stopping
 * the run and taking a waiting message back, each under the path and the
 * names the server reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiPost = vi.fn(async (_url: string, _body?: unknown, _config?: unknown): Promise<unknown> => ({}));
const apiDelete = vi.fn(async (_url: string, _config?: unknown): Promise<unknown> => ({ status: 'removed' }));

vi.mock('@web/data/api/request', () => ({
  apiGet: vi.fn(),
  apiPost,
  apiDelete,
  runOnceRequest: (key: string) => ({ headers: { 'Idempotency-Key': key }, timeout: 0 }),
}));

const { chatApi } = await import('@web/data/api/chat');
const { API_BASE_PATH } = await import('@web/data/api/base-path');

beforeEach(() => {
  apiPost.mockClear();
  apiDelete.mockClear();
});

describe('sending to a conversation', () => {
  it('posts the body as it is, with the press key and no time limit', async () => {
    const answer = { status: 'queued', pending: [], running: true };
    apiPost.mockResolvedValueOnce(answer);
    const body = { id: 'm1', message: 'hi', project_id: 'p1', conversation_id: 'c1' };
    expect(await chatApi.sendMessage(body, 'k1')).toBe(answer);
    expect(apiPost).toHaveBeenCalledWith('/chat/message', body, { headers: { 'Idempotency-Key': 'k1' }, timeout: 0 });
  });
});

describe('asking where a conversation stands', () => {
  it('posts the project to the conversation sync path', async () => {
    await chatApi.sync('c1', 'p1');
    expect(apiPost).toHaveBeenCalledWith('/chat/conversations/c1/sync', { project_id: 'p1' });
  });
});

describe('stopping a run', () => {
  it('names the conversation and the project the way the server reads them', async () => {
    await chatApi.stop('c1', 'p1');
    expect(apiPost).toHaveBeenCalledWith('/chat/stop', { conversation_id: 'c1', project_id: 'p1' });
  });

  it('names the run it means when it knows it', async () => {
    await chatApi.stop('c1', 'p1', 'r1');
    expect(apiPost).toHaveBeenCalledWith('/chat/stop', { conversation_id: 'c1', project_id: 'p1', run_id: 'r1' });
  });
});

describe('taking a waiting message back', () => {
  it('deletes it from the conversation queue with the project in the body, and answers how it stood', async () => {
    apiDelete.mockResolvedValueOnce({ status: 'taken' });
    expect(await chatApi.removeQueued('c1', 'm1', 'p1')).toBe('taken');
    expect(apiDelete).toHaveBeenCalledWith('/chat/conversations/c1/queue/m1', { data: { project_id: 'p1' } });
  });
});

describe('the stream a run is read from', () => {
  it('is read from the conversation stream path under the API prefix', () => {
    expect(chatApi.streamPath('c1')).toBe(`${API_BASE_PATH}/chat/conversations/c1/stream`);
  });
});
