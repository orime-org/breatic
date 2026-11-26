// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RequestModule from '../request';
import type { MiniToolPlannedRequest } from '@breatic/shared/mini-tools';
import { miniToolsApi } from '../mini-tools';
import { apiPost, runOnceRequest } from '../request';

vi.mock('../request', async (original) => ({ ...(await original<typeof RequestModule>()), apiPost: vi.fn() }));

const PROJECT = '20000000-0000-4000-8000-000000000001';
const RUN = '20000000-0000-4000-8000-000000000002';
const SOURCE = '20000000-0000-4000-8000-000000000003';
const TARGET = '20000000-0000-4000-8000-000000000004';
const BODY: MiniToolPlannedRequest = {
  tool: 'video.split', project_id: PROJECT, space_id: '20000000-0000-4000-8000-000000000005', run_id: RUN,
  draft: { version: 1, draftId: '20000000-0000-4000-8000-000000000006', revision: '20000000-0000-4000-8000-000000000007', source: { nodeId: SOURCE, canonicalURL: 'https://assets.example.test/source.webm', mediaInfo: { width: 400, height: 200, duration: 0.28, mimeType: 'video/webm' } }, inputs: [], params: { cuts: [] } },
  // §95: the planned request now carries the selected bundle's presentation_ref (design §10.8; fixture migration, 4.4.5).
  analysis_refs: [], presentation_ref: { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } },
  outputs: [{ outputIndex: 0, nodeId: TARGET, recipe: { kind: 'segment', range: { start: 0, end: 7 } } }],
};

beforeEach(() => vi.clearAllMocks());

describe('planned mini-tool API public wire, independent of HTTP envelope transport', () => {
  it.each(['pending', 'running', 'completed', 'failed', 'cancelled'] as const)('F12 preserves snake_case task_id and the %s SQL status', async (status) => {
    const answer = { task_id: RUN, status };
    vi.mocked(apiPost).mockResolvedValueOnce(answer);
    expect(await miniToolsApi.runPlanned(structuredClone(BODY), 'same-press-key')).toEqual(answer);
    expect(apiPost).toHaveBeenCalledWith('/mini-tools', BODY, runOnceRequest('same-press-key'));
  });

  it('F04 keeps the same body and Idempotency-Key on explicit API resend', async () => {
    vi.mocked(apiPost).mockResolvedValue({ task_id: RUN, status: 'running' });
    await miniToolsApi.runPlanned(BODY, 'same-press-key');
    await miniToolsApi.runPlanned(BODY, 'same-press-key');
    expect(vi.mocked(apiPost).mock.calls).toEqual([['/mini-tools', BODY, runOnceRequest('same-press-key')], ['/mini-tools', BODY, runOnceRequest('same-press-key')]]);
  });

  it('F12 preserves the original error of a refused planned request', async () => {
    const error = new Error('admission refused');
    vi.mocked(apiPost).mockRejectedValueOnce(error);
    await expect(miniToolsApi.runPlanned(BODY, 'same-press-key')).rejects.toBe(error);
  });

});
