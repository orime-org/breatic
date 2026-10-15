// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';

import { request, apiGet, apiPost, apiPatch, apiDelete } from '@web/data/api/request';
import { ApiException, type ApiError } from '@web/data/api/types';

describe('ApiException', () => {
  it('exposes status / message / code from the wrapped ApiError', () => {
    const err: ApiError = { status: 404, message: 'Not found', code: 'NOT_FOUND' };
    const ex = new ApiException(err);
    expect(ex.status).toBe(404);
    expect(ex.code).toBe('NOT_FOUND');
    expect(ex.message).toBe('Not found');
    expect(ex.name).toBe('ApiException');
  });

  it('is an Error instance (can be thrown / caught)', () => {
    const ex = new ApiException({ status: 500, message: 'Boom' });
    expect(ex).toBeInstanceOf(Error);
    expect(() => {
      throw ex;
    }).toThrow('Boom');
  });

  it('code is optional', () => {
    const ex = new ApiException({ status: 400, message: 'Bad request' });
    expect(ex.code).toBeUndefined();
  });
});

// Envelope unwrap invariant — backend returns `{ data: T }` for all
// endpoints (ApiResponse contract; DD #152). Helpers must unwrap to T so
// callers don't double-dot (`res.data.data`). RED test: current
// implementation returns `res.data` = `{ data: T }`, not T.
describe('helper envelope unwrap (DD #152)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('apiGet unwraps { data: T } envelope to T', async () => {
    vi.spyOn(request, 'get').mockResolvedValueOnce({
      data: { data: { id: 'p1', name: 'Demo' } },
    } as never);
    const result = await apiGet<{ id: string; name: string }>('/projects/p1');
    expect(result).toEqual({ id: 'p1', name: 'Demo' });
  });

  it('apiPost unwraps { data: T } envelope to T (201 entity)', async () => {
    vi.spyOn(request, 'post').mockResolvedValueOnce({
      data: { data: { id: 'p2', name: 'New' } },
    } as never);
    const result = await apiPost<{ id: string; name: string }>('/projects', {
      name: 'New',
    });
    expect(result).toEqual({ id: 'p2', name: 'New' });
  });

  it('apiPatch unwraps { data: T } envelope to T (partial update)', async () => {
    vi.spyOn(request, 'patch').mockResolvedValueOnce({
      data: { data: { id: 'p1', name: 'Updated' } },
    } as never);
    const result = await apiPatch<{ id: string; name: string }>(
      '/projects/p1',
      { name: 'Updated' },
    );
    expect(result).toEqual({ id: 'p1', name: 'Updated' });
  });

  it('apiDelete unwraps { data: T } envelope to T (success ack)', async () => {
    vi.spyOn(request, 'delete').mockResolvedValueOnce({
      data: { data: { success: true } },
    } as never);
    const result = await apiDelete<{ success: boolean }>('/projects/p1');
    expect(result).toEqual({ success: true });
  });
});

describe('a refusal that says how long to wait', () => {
  it('carries retryAfterSeconds from the error envelope onto the ApiException', async () => {
    const failure = request.get('/wait', {
      adapter: (config) =>
        Promise.reject(
          new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, {
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'retry-after': '37' },
            config,
            data: { error: { code: 429, message: 'Wait 37 seconds', retryAfterSeconds: 37 } },
          }),
        ),
    });
    await expect(failure).rejects.toMatchObject({
      status: 429,
      message: 'Wait 37 seconds',
      retryAfterSeconds: 37,
    });
  });

  it('leaves retryAfterSeconds undefined when the server did not send one', async () => {
    const failure = request.get('/plain', {
      adapter: (config) =>
        Promise.reject(
          new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, {
            status: 400,
            statusText: 'Bad Request',
            headers: {},
            config,
            data: { error: { code: 400, message: 'That code is incorrect.' } },
          }),
        ),
    });
    const err: unknown = await failure.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiException);
    expect((err as ApiException).retryAfterSeconds).toBeUndefined();
  });
});

// inner#1490: a run-once press tells "the server finished" from "nothing
// reliable came back" by the response headers, which only the error path
// has to read.
describe('what a failed answer says about a run-once press', () => {
  /**
   * Post through the real client with an adapter that answers as given.
   * @param answer - The response the adapter fails with, or null for none.
   * @returns The ApiException the client rejected with.
   */
  async function failWith(
    answer: { status: number; headers?: Record<string, string>; data?: unknown } | null,
  ): Promise<ApiException> {
    const caught = await request
      .post('/x', {}, {
        adapter: (config) =>
          Promise.reject(
            new AxiosError(
              'failed',
              answer ? 'ERR_BAD_RESPONSE' : 'ERR_NETWORK',
              config,
              null,
              answer
                ? {
                  status: answer.status,
                  statusText: '',
                  headers: answer.headers ?? {},
                  config,
                  data: answer.data ?? {},
                }
                : undefined,
            ),
          ),
      })
      .catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(ApiException);
    return caught as ApiException;
  }

  it('reads the Idempotency-Status the server set', async () => {
    const err = await failWith({ status: 409, headers: { 'idempotency-status': 'in_progress' } });
    expect(err.idempotencyStatus).toBe('in_progress');
    expect(err.network).toBe(false);
  });

  it('reads a finished error as done', async () => {
    const err = await failWith({ status: 403, headers: { 'idempotency-status': 'done' } });
    expect(err.idempotencyStatus).toBe('done');
  });

  it('has no status when a proxy answered', async () => {
    const err = await failWith({ status: 524 });
    expect(err.idempotencyStatus).toBeUndefined();
    expect(err.status).toBe(524);
  });

  it('marks an answer that never arrived as a network failure', async () => {
    const err = await failWith(null);
    expect(err.status).toBe(0);
    expect(err.network).toBe(true);
  });

  it('reads the wait from Retry-After when the body names none', async () => {
    const err = await failWith({ status: 429, headers: { 'retry-after': '12' } });
    expect(err.retryAfterSeconds).toBe(12);
  });

  it('does not mark a local throw as a network failure', () => {
    const err = new ApiException({ status: 0, message: 'boom' });
    expect(err.network).toBe(false);
  });
});
