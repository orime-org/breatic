// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { videoPresentationQuery, repairVideoPresentation } from '../video-presentation-query';
import { ApiException } from '@web/data/api/types';

const { apiGet, apiPost, toastError } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), toastError: vi.fn() }));
vi.mock('@web/data/api/request', async (original) => ({ ...await original<Record<string, unknown>>(), apiGet, apiPost }));
vi.mock('@web/lib/toast', async (original) => ({ ...await original<Record<string, unknown>>(), toast: { error: toastError } }));
const input = { projectId: 'project-a', canonicalURL: 'https://assets.example.test/canonical.webm', active: true };
const binding = { assetId: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', contentHash: 'a'.repeat(64), canonicalURL: input.canonicalURL,
  kind: 'video', mediaInfo: { width: null, height: null, duration: null, mimeType: 'video/webm' } };
const unknown = { sourceBinding: binding, presentation: null, preparation: null, pollAfterMs: null };
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  apiGet.mockReset().mockResolvedValue(unknown);
  apiPost.mockReset();
  toastError.mockReset();
});
afterEach(() => { client.clear(); vi.useRealTimers(); });

describe('canonical presentation query (inner#1306 Canvas §17)', () => {
  it('uses the authorized axios endpoint and retains unknown as unknown', async () => {
    expect(await client.fetchQuery(videoPresentationQuery(input))).toEqual(unknown);
    expect(apiGet).toHaveBeenCalledWith(`/projects/${input.projectId}/assets/video-presentation`, expect.objectContaining({
      params: { url: input.canonicalURL }, signal: expect.any(AbortSignal),
    }));
  });

  it('deduplicates concurrent consumers of the same project, source and schema version', async () => {
    const result = await Promise.all([client.fetchQuery(videoPresentationQuery(input)), client.fetchQuery(videoPresentationQuery(input))]);
    expect(result).toEqual([unknown, unknown]);
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(videoPresentationQuery(input).queryKey).toEqual(['video-presentation', 1, input.projectId, input.canonicalURL]);
  });

  it('rejects a descriptor for a different registered source', async () => {
    apiGet.mockResolvedValue({ ...unknown, presentation: { schemaVersion: 1, sourceFingerprint: 'b'.repeat(64),
      original: { width: 95, height: 63, duration: 2.4 }, state: 'native' } });
    await expect(client.fetchQuery(videoPresentationQuery(input))).rejects.toThrow();
  });

  it('polls only while accepted work is pending using the returned interval', async () => {
    vi.useFakeTimers();
    const pending = { ...unknown, preparation: { status: 'running', attempt: { jobId: 'fixed', deadlineAt: 1900000000000 } }, pollAfterMs: 1234 };
    apiGet.mockResolvedValueOnce(pending).mockResolvedValue(unknown);
    const observer = new QueryObserver(client, videoPresentationQuery(input));
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data).toEqual(pending);
    await vi.advanceTimersByTimeAsync(1234);
    expect(apiGet).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(apiGet).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('cancels consumption when the last source observer leaves', async () => {
    apiGet.mockImplementation(async (_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const observer = new QueryObserver(client, videoPresentationQuery(input));
    const unsubscribe = observer.subscribe(() => undefined);
    unsubscribe();
    expect(apiGet).toHaveBeenCalledTimes(1);
    const signal = apiGet.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(client.getQueryState(videoPresentationQuery(input).queryKey)?.fetchStatus).toBe('idle');
  });

  it('repairs the registered canonical source with the same idempotent press identity', async () => {
    const attempt = { jobId: 'accepted-repair', deadlineAt: 1900000000000 };
    const answer = { ...unknown, attempt, preparation: { status: 'accepted', attempt }, pollAfterMs: 5000 };
    apiPost.mockResolvedValue(answer);
    expect(await repairVideoPresentation({ ...input, sourceFingerprint: binding.contentHash }, 'repair-press')).toEqual(answer);
    expect(apiPost).toHaveBeenCalledWith(`/projects/${input.projectId}/assets/video-presentation/repair`, {
      canonicalURL: input.canonicalURL, sourceFingerprint: binding.contentHash,
    }, expect.objectContaining({ headers: { 'Idempotency-Key': 'repair-press' }, timeout: 0 }));
  });

  it('reports a source conflict before propagating the same repair failure', async () => {
    const failure = new ApiException({ status: 409, message: 'The source changed.', fromServer: true });
    apiPost.mockRejectedValue(failure);
    await expect(repairVideoPresentation({ ...input, sourceFingerprint: binding.contentHash }, 'repair-press')).rejects.toBe(failure);
    expect(toastError).toHaveBeenCalledWith('The source changed.');
    expect(apiGet).not.toHaveBeenCalled();
  });
});
