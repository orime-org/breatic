// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The web side of the web-animation execution endpoints (inner#1711 design §4, #1490 design §4).
 *
 * Accepting and cancelling are presses that must run once, so each carries an `Idempotency-Key` the caller reuses
 * on resend; accepting also says whether this press created the row (201) or found it (200). Reads go through
 * `apiGet`, which already unwraps `{ data }`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet, apiPost, request } from '@web/data/api/request';
import { timelineApi } from '@web/data/api/timeline';

vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  request: { post: vi.fn() },
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
  vi.mocked(request.post).mockReset().mockResolvedValue({ status: 201, data: { data: { id: EXECUTION } } });
});

describe('timelineApi executions', () => {
  it('lists one page of a Motion Space\'s group', async () => {
    const signal = new AbortController().signal;
    await timelineApi.listSpaceExecutions({ projectId: PROJECT, spaceId: SPACE, scope: 'space', group: 'running', cursor: 'c1' }, signal);
    expect(apiGet).toHaveBeenCalledWith('/timeline/space-executions', expect.objectContaining({
      params: { projectId: PROJECT, spaceId: SPACE, scope: 'space', group: 'running', cursor: 'c1' }, signal,
    }));
  });

  it('lists the Project\'s results for the Timeline picker', async () => {
    await timelineApi.listResults(PROJECT, 'c2');
    expect(apiGet).toHaveBeenCalledWith('/timeline/results', expect.objectContaining({ params: { projectId: PROJECT, cursor: 'c2' } }));
  });

  it('reads one execution as the asking Motion Space sees it', async () => {
    await timelineApi.getExecution(PROJECT, SPACE, EXECUTION);
    expect(apiGet).toHaveBeenCalledWith(`/timeline/executions/${EXECUTION}`, expect.objectContaining({ params: { projectId: PROJECT, spaceId: SPACE } }));
  });

  it('accepts a kinded request with the run-once key and says a 201 created the row', async () => {
    const body = {
      projectId: PROJECT, spaceId: SPACE, actionId: KEY, kind: 'web_animation_create' as const, prompt: 'A title slides in',
      engine: 'deepseek' as const, aspect: '16:9' as const, durationSeconds: 4,
    };
    await expect(timelineApi.acceptExecution(body, KEY)).resolves.toEqual({ row: { id: EXECUTION }, created: true });
    const [url, sentBody, config] = vi.mocked(request.post).mock.calls[0] ?? [];
    expect(url).toBe('/timeline/executions');
    expect(sentBody).toEqual(body);
    expect(headersOf(config)['Idempotency-Key']).toBe(KEY);
  });

  it('says a 200 answered a row that already existed', async () => {
    vi.mocked(request.post).mockResolvedValue({ status: 200, data: { data: { id: EXECUTION } } });
    const body = { projectId: PROJECT, spaceId: SPACE, actionId: KEY, kind: 'web_animation_export' as const, sourceVersionId: SOURCE };
    await expect(timelineApi.acceptExecution(body, KEY)).resolves.toEqual({ row: { id: EXECUTION }, created: false });
  });

  it('cancels with the asking Project and the run-once key the route requires', async () => {
    await timelineApi.cancelExecution(EXECUTION, PROJECT, KEY);
    const [url, sentBody, config] = vi.mocked(apiPost).mock.calls[0] ?? [];
    expect(url).toBe(`/timeline/executions/${EXECUTION}/cancel`);
    expect(sentBody).toEqual({ projectId: PROJECT });
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
