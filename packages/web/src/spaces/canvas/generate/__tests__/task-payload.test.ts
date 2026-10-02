// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { buildGenerateTaskPayload, imageEstimateInput } from '@web/spaces/canvas/generate/task-payload';

const BASE = {
  nodeId: 'node-1',
  projectId: 'proj-1',
  spaceId: 'space-1',
  model: 'nano_banana_pro',
  params: { aspect_ratio: '16:9', resolution: '2K' },
  promptText: 'a red bicycle',
  poolParams: {} as Record<string, string[]>,
};

describe('buildGenerateTaskPayload — assembles the POST /canvas/tasks overwrite request', () => {
  it('builds an overwrite payload targeting the node', () => {
    expect(buildGenerateTaskPayload(BASE)).toEqual({
      task_type: 'image',
      model: 'nano_banana_pro',
      params: { prompt: 'a red bicycle', aspect_ratio: '16:9', resolution: '2K' },
      node_ids: ['node-1'],
      project_id: 'proj-1',
      space_id: 'space-1',
      source: 'task',
      target_node_id: 'node-1',
      mode: 'overwrite',
    });
  });

  it('never lets a model param named "prompt" overwrite the user prompt', () => {
    const out = buildGenerateTaskPayload({
      ...BASE,
      params: { aspect_ratio: '1:1', prompt: 'injected-by-model' },
    });
    expect(out.params.prompt).toBe('a red bicycle'); // the user's prompt always wins
  });

  it('puts the mentioned references under the params the model reads them from', () => {
    const out = buildGenerateTaskPayload({
      ...BASE,
      poolParams: { images: ['https://cdn/a.png', 'https://cdn/b.png'] },
    });
    expect(out.params.images).toEqual(['https://cdn/a.png', 'https://cdn/b.png']);
    expect(out.params.prompt).toBe('a red bicycle');
  });

  it('omits params.images entirely when there are no references', () => {
    const out = buildGenerateTaskPayload(BASE);
    expect('images' in out.params).toBe(false);
  });

  it('always uses overwrite mode, naming the node it writes to', () => {
    const out = buildGenerateTaskPayload(BASE);
    expect(out.mode).toBe('overwrite');
    expect(out.target_node_id).toBe('node-1');
  });
});

describe('imageEstimateInput — the run the price is quoted for', () => {
  it('carries the mentioned references, as the submit sends them', () => {
    const input = imageEstimateInput(
      {
        params: { resolution: '2K' },
        pool: { image: { param: 'images', cap: undefined } },
        referenceUrls: { image: ['https://cdn/a.png', 'https://cdn/b.png'], video: [], audio: [] },
      },
      'put it on white',
    );
    expect(input).toEqual({
      params: {
        resolution: '2K',
        images: ['https://cdn/a.png', 'https://cdn/b.png'],
      },
      prompt: 'put it on white',
    });
  });
});
