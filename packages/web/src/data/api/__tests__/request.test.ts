import { describe, it, expect, vi, beforeEach } from 'vitest';

import { request, apiGet, apiPost, apiPatch, apiDelete } from '@/data/api/request';
import { ApiException, type ApiError } from '@/data/api/types';

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
// endpoints (ApiResponse 规约; DD #152). Helpers must unwrap to T so
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
