// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web side of the Timeline execution endpoints (inner#1711 design §4).
 *
 * Accepting and cancelling are presses that must run once, so each carries an `Idempotency-Key` the caller reuses
 * on resend; reads go through `apiGet`, which already unwraps `{ data }`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '@web/data/api/request';
import { timelineApi } from '@web/data/api/timeline';

vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const EXECUTION = '90000000-0000-4000-8000-000000000001';
const SOURCE = '80000000-0000-4000-8000-000000000001';
const KEY = 'b0000000-0000-4000-8000-000000000001';

/**
 * The headers a mocked call was sent with.
 * @param config - The axios config argument.
 * @returns Its headers.
 * @throws {never} Never.
 */
function headersOf(config: unknown): Record<string, unknown> {
  return ((config as { headers?: Record<string, unknown> } | undefined)?.headers) ?? {};
}

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue([]);
  vi.mocked(apiPost).mockReset().mockResolvedValue({});
});

describe('timelineApi executions', () => {
  it('lists one Space executions of this Project', async () => {
    const signal = new AbortController().signal;
    await timelineApi.listExecutions(PROJECT, SPACE, signal);
    expect(apiGet).toHaveBeenCalledWith('/timeline/executions', expect.objectContaining({ params: { projectId: PROJECT, spaceId: SPACE }, signal }));
  });

  it('accepts a creation with the run-once key', async () => {
    const body = {
      projectId: PROJECT, spaceId: SPACE, actionId: KEY, prompt: 'A title slides in', engine: 'deepseek' as const,
      aspect: '16:9' as const, durationSeconds: 4, fps: { num: 24, den: 1 },
    };
    await timelineApi.acceptExecution(body, KEY);
    const [url, sentBody, config] = vi.mocked(apiPost).mock.calls[0] ?? [];
    expect(url).toBe('/timeline/executions');
    expect(sentBody).toEqual(body);
    expect(headersOf(config)['Idempotency-Key']).toBe(KEY);
  });

  it('cancels with the run-once key the route requires', async () => {
    await timelineApi.cancelExecution(EXECUTION, KEY);
    const [url, , config] = vi.mocked(apiPost).mock.calls[0] ?? [];
    expect(url).toBe(`/timeline/executions/${EXECUTION}/cancel`);
    expect(headersOf(config)['Idempotency-Key']).toBe(KEY);
  });

  it('resolves the referenced sources and executions as comma-separated lists', async () => {
    vi.mocked(apiGet).mockResolvedValue({ sources: {}, executions: {} });
    await timelineApi.resolveWebSources(PROJECT, { sourceIds: [SOURCE], executionIds: [EXECUTION, KEY] });
    expect(apiGet).toHaveBeenCalledWith('/timeline/web-sources', expect.objectContaining({
      params: { projectId: PROJECT, sourceIds: SOURCE, executionIds: `${EXECUTION},${KEY}` },
    }));
  });

  it('asks for a preview address through this Project', async () => {
    vi.mocked(apiGet).mockResolvedValue({ url: 'https://preview.example/web-animation/t/index.html' });
    await expect(timelineApi.previewUrl(PROJECT, SOURCE)).resolves.toEqual({ url: 'https://preview.example/web-animation/t/index.html' });
    expect(apiGet).toHaveBeenCalledWith(`/timeline/sources/${SOURCE}/preview`, expect.objectContaining({ params: { projectId: PROJECT } }));
  });
});
