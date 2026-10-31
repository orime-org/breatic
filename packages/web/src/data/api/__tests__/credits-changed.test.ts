// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every request that holds or spends a project's credits says so when it
 * returns, whether it was admitted or refused (inner#1611), so the figure on
 * the project's top bar can be read again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/data/api/request', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  runOnceRequest: (key: string) => ({ headers: { 'Idempotency-Key': key } }),
}));

import { apiPost } from '@web/data/api/request';
import { canvasApi } from '@web/data/api/canvas';
import { miniToolsApi } from '@web/data/api/mini-tools';
import { onCreditsChanged } from '@web/data/api/credits';

const PROJECT = '11111111-1111-4111-8111-111111111111';

let heard: string[] = [];
let stop: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  stop();
  heard = [];
  stop = onCreditsChanged((projectId) => void heard.push(projectId));
});

const RUNS: { name: string; run: () => Promise<unknown> }[] = [
  {
    name: 'a generation',
    run: () => canvasApi.createTask({ project_id: PROJECT } as never, 'k1'),
  },
  {
    name: 'a reading',
    run: () =>
      canvasApi.understand(
        { project_id: PROJECT, space_id: 's', source_type: 'image', source_url: 'u', node_ids: [], reader_locale: 'en' },
        'k2',
      ),
  },
  { name: 'a mini-tool run', run: () => miniToolsApi.run({ project_id: PROJECT } as never, 'k3') },
];

describe.each(RUNS)('$name', ({ run }) => {
  it('says the project\'s credits changed once it was admitted', async () => {
    vi.mocked(apiPost).mockResolvedValueOnce({});
    await run();
    expect(heard).toEqual([PROJECT]);
  });

  it('says so when it was refused as well', async () => {
    vi.mocked(apiPost).mockRejectedValueOnce(new Error('402'));
    await run().catch(() => undefined);
    expect(heard).toEqual([PROJECT]);
  });
});

describe('onCreditsChanged', () => {
  it('stops telling a listener that has let go', async () => {
    stop();
    vi.mocked(apiPost).mockResolvedValueOnce({});
    await canvasApi.createTask({ project_id: PROJECT } as never, 'k4');
    expect(heard).toEqual([]);
  });
});
