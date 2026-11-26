// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { videoPresentationQuery, repairVideoPresentation } from '../video-presentation-query';
import { ApiException } from '@web/data/api/types';
import { presentedBinding, presentedBundle, presentedPreparation, presentedResponse } from '@web/test-utils/video-presentation';

const { apiGet, apiPost, toastError } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), toastError: vi.fn() }));
vi.mock('@web/data/api/request', async (original) => ({ ...await original<Record<string, unknown>>(), apiGet, apiPost }));
vi.mock('@web/lib/toast', async (original) => ({ ...await original<Record<string, unknown>>(), toast: { error: toastError } }));
const input = { projectId: 'project-a', canonicalURL: 'https://assets.example.test/canonical.webm', active: true };
// §95 (design §3.5 web→server row): the read answers the selected bundle and the target policy's preparation; a repair
// answers the same response.
const binding = presentedBinding(input.canonicalURL);
const unknown = presentedResponse(binding);
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
    apiGet.mockResolvedValue({ ...unknown, presentation: presentedBundle(input.canonicalURL, { sourceFingerprint: 'b'.repeat(64) }) });
    await expect(client.fetchQuery(videoPresentationQuery(input))).rejects.toThrow();
  });

  it('reads once while accepted work is pending and never again on a timer (frames-split §7.20)', async () => {
    vi.useFakeTimers();
    const pending = presentedResponse(binding, { preparation: presentedPreparation(null, 'encode') });
    apiGet.mockResolvedValueOnce(pending).mockResolvedValue(unknown);
    const observer = new QueryObserver(client, videoPresentationQuery(input));
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data).toEqual(pending);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apiGet).toHaveBeenCalledTimes(1);
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
    const answer = presentedResponse(binding, { preparation: presentedPreparation(null) });
    apiPost.mockResolvedValue(answer);
    expect(await repairVideoPresentation({ ...input, sourceFingerprint: binding.contentHash }, 'repair-press')).toEqual(answer);
    expect(apiPost).toHaveBeenCalledWith(`/projects/${input.projectId}/assets/video-presentation/repair`, {
      canonicalURL: input.canonicalURL, sourceFingerprint: binding.contentHash,
    }, expect.objectContaining({ headers: { 'Idempotency-Key': 'repair-press' }, timeout: 0 }));
  });

  // §95 (design §3.5 web→server row, §7.12): the repair's answer is the read response itself, parsed by the same strict
  // schema; the earlier repair shape (an `attempt` beside a status preparation) is refused, as is a bundle of another source.
  it.each([
    ['the earlier repair attempt field', { attempt: { jobId: 'accepted-repair', deadlineAt: 1900000000000 } }],
    ['a bundle of another source', { presentation: presentedBundle(input.canonicalURL, { sourceFingerprint: 'b'.repeat(64) }), preparation: null }],
  ])('refuses a repair answer with %s', async (_name, change) => {
    apiPost.mockResolvedValue({ ...presentedResponse(binding, { preparation: presentedPreparation(null) }), ...change });
    await expect(repairVideoPresentation({ ...input, sourceFingerprint: binding.contentHash }, 'repair-press')).rejects.toThrow();
  });

  it('reports a source conflict before propagating the same repair failure', async () => {
    const failure = new ApiException({ status: 409, message: 'The source changed.', fromServer: true });
    apiPost.mockRejectedValue(failure);
    await expect(repairVideoPresentation({ ...input, sourceFingerprint: binding.contentHash }, 'repair-press')).rejects.toBe(failure);
    expect(toastError).toHaveBeenCalledWith('The source changed.');
    expect(apiGet).not.toHaveBeenCalled();
  });
});
