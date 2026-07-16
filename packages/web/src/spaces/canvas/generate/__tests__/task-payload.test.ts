// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { buildGenerateTaskPayload } from '@web/spaces/canvas/generate/task-payload';

const BASE = {
  nodeId: 'node-1',
  projectId: 'proj-1',
  spaceId: 'space-1',
  model: 'nano_banana_pro',
  params: { aspect_ratio: '16:9', resolution: '2K' },
  promptText: 'a red bicycle',
  referenceUrls: [] as string[],
  leaseGen: 3,
};

describe('buildGenerateTaskPayload — assembles the POST /canvas/tasks overwrite request', () => {
  it('builds an overwrite payload targeting the node, with gen = leaseGen + 1', () => {
    expect(buildGenerateTaskPayload(BASE)).toEqual({
      task_type: 'image',
      model: 'nano_banana_pro',
      params: { prompt: 'a red bicycle', aspect_ratio: '16:9', resolution: '2K' },
      node_ids: ['node-1'],
      project_id: 'proj-1',
      space_id: 'space-1',
      source: 'canvas',
      target_node_id: 'node-1',
      mode: 'overwrite',
      node_gens: { 'node-1': 4 },
    });
  });

  it('never lets a model param named "prompt" overwrite the user prompt', () => {
    const out = buildGenerateTaskPayload({
      ...BASE,
      params: { aspect_ratio: '1:1', prompt: 'injected-by-model' },
    });
    expect(out.params.prompt).toBe('a red bicycle'); // the user's prompt always wins
  });

  it('puts the reference source URLs under params.images when references exist', () => {
    const out = buildGenerateTaskPayload({
      ...BASE,
      referenceUrls: ['https://cdn/a.png', 'https://cdn/b.png'],
    });
    expect(out.params.images).toEqual(['https://cdn/a.png', 'https://cdn/b.png']);
    expect(out.params.prompt).toBe('a red bicycle');
  });

  it('omits params.images entirely when there are no references', () => {
    const out = buildGenerateTaskPayload(BASE);
    expect('images' in out.params).toBe(false);
  });

  it('puts the style image under params.style_images as a one-element list (#1664)', () => {
    const out = buildGenerateTaskPayload({
      ...BASE,
      styleImageUrl: 'https://cdn/style-a.png',
    });
    expect(out.params.style_images).toEqual(['https://cdn/style-a.png']);
  });

  it('omits params.style_images entirely when no style image is picked', () => {
    const out = buildGenerateTaskPayload(BASE);
    expect('style_images' in out.params).toBe(false);
  });

  it('sends images (i2i sources) and style_images independently in one payload', () => {
    const out = buildGenerateTaskPayload({
      ...BASE,
      referenceUrls: ['https://cdn/src.png'],
      styleImageUrl: 'https://cdn/style.png',
    });
    expect(out.params.images).toEqual(['https://cdn/src.png']);
    expect(out.params.style_images).toEqual(['https://cdn/style.png']);
  });

  it('defaults a missing leaseGen to 0 so the first generation carries gen = 1', () => {
    const out = buildGenerateTaskPayload({ ...BASE, leaseGen: undefined });
    expect(out.node_gens).toEqual({ 'node-1': 1 });
  });

  it('always uses overwrite mode with the target node covered by node_gens', () => {
    const out = buildGenerateTaskPayload(BASE);
    expect(out.mode).toBe('overwrite');
    expect(out.target_node_id).toBe('node-1');
    expect(out.node_gens?.['node-1']).toBeDefined();
  });
});
