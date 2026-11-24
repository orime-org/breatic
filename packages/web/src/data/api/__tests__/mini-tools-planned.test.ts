// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RequestModule from '../request';
import type * as CreditsModule from '../credits';
import type { MiniToolExecutionRecord, MiniToolPlannedRequest } from '@breatic/shared/mini-tools';
import { miniToolsApi } from '../mini-tools';
import { apiGet, apiPost, runOnceRequest } from '../request';
import { noteCreditsChanged } from '../credits';

vi.mock('../request', async (original) => ({ ...(await original<typeof RequestModule>()), apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../credits', async (original) => ({ ...(await original<typeof CreditsModule>()), noteCreditsChanged: vi.fn() }));

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
const RECORD: MiniToolExecutionRecord = {
  schemaVersion: 1, runId: RUN, status: 'completed', planFingerprint: 'b'.repeat(64), resultVersion: 1,
  sourceBindings: [{ assetId: SOURCE, contentHash: 'a'.repeat(64), canonicalURL: BODY.draft.source.canonicalURL, kind: 'video', mediaInfo: BODY.draft.source.mediaInfo }],
  outputs: [{ outputIndex: 0, nodeId: TARGET, recipe: { kind: 'segment', range: { start: 0, end: 7 } }, result: { status: 'registered', assetId: '20000000-0000-4000-8000-000000000008', canonicalURL: 'https://assets.example.test/canonical-alpha.webm', kind: 'video', mimeType: 'video/webm', size: 321, contentHash: 'c'.repeat(64), width: 400, height: 200, duration: 0.28, cover: null } }],
  usage: [], billingState: 'waiting', error: null,
};

beforeEach(() => vi.clearAllMocks());

describe('planned mini-tool API public wire, independent of HTTP envelope transport', () => {
  it.each(['pending', 'running', 'completed', 'failed', 'cancelled'] as const)('F12 preserves snake_case task_id and the %s SQL status', async (status) => {
    const answer = { task_id: RUN, status };
    vi.mocked(apiPost).mockResolvedValueOnce(answer);
    expect(await miniToolsApi.runPlanned(structuredClone(BODY), 'same-press-key')).toEqual(answer);
    expect(apiPost).toHaveBeenCalledWith('/mini-tools', BODY, runOnceRequest('same-press-key'));
    expect(noteCreditsChanged).toHaveBeenCalledWith(PROJECT);
  });

  it('F04 keeps the same body and Idempotency-Key on explicit API resend', async () => {
    vi.mocked(apiPost).mockResolvedValue({ task_id: RUN, status: 'running' });
    await miniToolsApi.runPlanned(BODY, 'same-press-key');
    await miniToolsApi.runPlanned(BODY, 'same-press-key');
    expect(vi.mocked(apiPost).mock.calls).toEqual([['/mini-tools', BODY, runOnceRequest('same-press-key')], ['/mini-tools', BODY, runOnceRequest('same-press-key')]]);
  });

  it('F12 refreshes the project credit view after a refused planned request and preserves the original error', async () => {
    const error = new Error('admission refused');
    vi.mocked(apiPost).mockRejectedValueOnce(error);
    await expect(miniToolsApi.runPlanned(BODY, 'same-press-key')).rejects.toBe(error);
    expect(noteCreditsChanged).toHaveBeenCalledExactlyOnceWith(PROJECT);
  });

  it('F12/F14 reads the exact project/run endpoint and retains registered canonical media while billing is waiting', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce(structuredClone(RECORD));
    expect(await miniToolsApi.getRun(PROJECT, RUN)).toEqual(RECORD);
    expect(apiGet).toHaveBeenCalledExactlyOnceWith(`/projects/${PROJECT}/mini-tool-runs/${RUN}`);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('F12 rejects an invalid execution record instead of inventing terminal media', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ ...RECORD, outputs: [{ ...RECORD.outputs[0], result: null }] });
    await expect(miniToolsApi.getRun(PROJECT, RUN)).rejects.toThrow();
    expect(apiGet).toHaveBeenCalledExactlyOnceWith(`/projects/${PROJECT}/mini-tool-runs/${RUN}`);
  });
});
