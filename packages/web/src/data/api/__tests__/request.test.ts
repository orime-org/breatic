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
