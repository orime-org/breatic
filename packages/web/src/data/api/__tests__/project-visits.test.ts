// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/data/api/request', () => ({
  apiGet: vi.fn(), apiPost: vi.fn(), apiPatch: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn(), runOnceRequest: vi.fn(),
}));

import { apiGet, apiPost } from '@web/data/api/request';
import { projectsApi } from '@web/data/api/projects';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000011';
const VISIT = '00000000-0000-4000-8000-000000000101';
const RECEIPT = { account_id: ACCOUNT, project_id: PROJECT, visit_id: VISIT, occurred_at: '2026-11-02T23:59:59.123456Z' };

beforeEach(() => { vi.clearAllMocks(); });

describe('project visit transport (inner#1893)', () => {
  it('submits the original visit identity and cancellation signal to opened', async () => {
    const signal = new AbortController().signal;
    vi.mocked(apiPost).mockResolvedValue({ ok: true, ...RECEIPT });
    const answer = await projectsApi.recordOpen(PROJECT, VISIT, signal);
    expect(apiPost).toHaveBeenCalledExactlyOnceWith(`/projects/${PROJECT}/opened`, { visit_id: VISIT }, { signal });
    expect(answer).toEqual({ ok: true, ...RECEIPT });
  });

  it('looks the original receipt up without submitting another open', async () => {
    const signal = new AbortController().signal;
    vi.mocked(apiGet).mockResolvedValue({ status: 'recorded', ...RECEIPT });
    const answer = await projectsApi.getOpenReceipt(PROJECT, VISIT, signal);
    expect(apiGet).toHaveBeenCalledExactlyOnceWith(`/projects/${PROJECT}/opened/${VISIT}`, { signal });
    expect(apiPost).not.toHaveBeenCalled();
    expect(answer).toEqual({ status: 'recorded', ...RECEIPT });
  });

  it('preserves the unconfirmed identity returned by the receipt lookup', async () => {
    const result = { status: 'unconfirmed', account_id: ACCOUNT, project_id: PROJECT, visit_id: VISIT };
    vi.mocked(apiGet).mockResolvedValue(result);
    expect(await projectsApi.getOpenReceipt(PROJECT, VISIT)).toEqual(result);
    expect(apiPost).not.toHaveBeenCalled();
  });
});
