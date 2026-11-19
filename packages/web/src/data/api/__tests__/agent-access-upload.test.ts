// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => ({ apiPost: vi.fn(), apiGet: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@web/data/api/request', () => request);

import { agentAccessApi } from '@web/data/api/agent-access';

beforeEach(() => {
  vi.clearAllMocks();
  request.apiPost.mockResolvedValue(undefined);
});

describe('uploadViewCapture (#1488 §19.1)', () => {
  it('sends the capture as multipart, not as the instance default JSON', async () => {
    await agentAccessApi.uploadViewCapture('r1', { image: new Blob(['x'], { type: 'image/webp' }), view: { a: 1 } });
    const [url, body, config] = request.apiPost.mock.calls[0] as [string, FormData, { headers?: Record<string, string> }];
    expect(url).toBe('/agent/view-captures/r1');
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('view')).toBe('{"a":1}');
    expect(body.get('image')).toBeInstanceOf(Blob);
    expect(config?.headers?.['Content-Type']).toBe('multipart/form-data');
  });
});
