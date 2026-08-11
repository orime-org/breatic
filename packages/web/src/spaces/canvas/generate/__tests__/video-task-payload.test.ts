// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { buildVideoTaskPayload } from '@web/spaces/canvas/generate/video-task-payload';

const BASE = {
  nodeId: 'node-1',
  projectId: 'proj-1',
  spaceId: 'space-1',
  model: 'veo-3.1',
  params: { aspect_ratio: '16:9', resolution: '720p', duration: 8 },
  promptText: 'a drone shot over a canyon at dawn',
  leaseGen: 3,
  mode: 't2v',
  slotUrls: {},
};

describe('buildVideoTaskPayload', () => {
  it('builds an overwrite payload targeting the node, with gen = leaseGen + 1', () => {
    expect(buildVideoTaskPayload(BASE)).toEqual({
      task_type: 'video',
      model: 'veo-3.1',
      params: {
        prompt: 'a drone shot over a canyon at dawn',
        aspect_ratio: '16:9',
        resolution: '720p',
        duration: 8,
      },
      node_ids: ['node-1'],
      project_id: 'proj-1',
      space_id: 'space-1',
      source: 'canvas',
      target_node_id: 'node-1',
      mode: 'overwrite',
      node_gens: { 'node-1': 4 },
    });
  });

  it('sends image-to-video the first frame, as the `image` param', () => {
    // The backend source gate reads it from `params.image`
    // (source-requirement.ts maps `i2v` to `["image"]`). It travels as its OWN
    // param, never folded into the reference array — that array is the
    // @-picked pool and means something different.
    const out = buildVideoTaskPayload({
      ...BASE,
      mode: 'i2v',
      slotUrls: { firstFrame: 'https://cdn/first.png' },
    });
    expect(out.params).toMatchObject({ image: 'https://cdn/first.png' });
    expect(out.params).not.toHaveProperty('end_image');
  });

  it('sends first-last frame both frames, under their own params', () => {
    const out = buildVideoTaskPayload({
      ...BASE,
      mode: 'first_last',
      slotUrls: {
        firstFrame: 'https://cdn/first.png',
        endFrame: 'https://cdn/last.png',
      },
    });
    expect(out.params).toMatchObject({
      image: 'https://cdn/first.png',
      end_image: 'https://cdn/last.png',
    });
  });

  it('carries only what the active mode collects, whatever else was picked', () => {
    // Switching back to image-to-video leaves the end frame on the node: the
    // slot stops rendering but the pick is not thrown away (user 2026-08-10,
    // "change either one whenever you like"). It cannot ride the payload,
    // because image-to-video's field set does not contain it — the mode
    // decides what is built, so nothing has to guard against it afterwards.
    const out = buildVideoTaskPayload({
      ...BASE,
      mode: 'i2v',
      slotUrls: {
        firstFrame: 'https://cdn/first.png',
        endFrame: 'https://cdn/left-behind.png',
      },
    });
    expect(out.params).toMatchObject({ image: 'https://cdn/first.png' });
    expect(out.params).not.toHaveProperty('end_image');
  });

  it('omits a slot the mode collects but nobody filled', () => {
    // The upstream provider reads a source field's presence, not its value, so
    // an empty slot must leave no key behind.
    const out = buildVideoTaskPayload({ ...BASE, mode: 'i2v', slotUrls: {} });
    expect(out.params).not.toHaveProperty('image');
  });

  it('sends text-to-video no source field at all', () => {
    expect(buildVideoTaskPayload(BASE).params).not.toHaveProperty('image');
    expect(buildVideoTaskPayload(BASE).params).not.toHaveProperty('end_image');
  });

  it('routes to the video task type, not the image one', () => {
    // The worker keys its handler off this; sending 'image' would run a video
    // generation through the image pipeline.
    expect(buildVideoTaskPayload(BASE).task_type).toBe('video');
  });

  it('never lets a model param named "prompt" overwrite what the user typed', () => {
    const out = buildVideoTaskPayload({
      ...BASE,
      params: { duration: 8, prompt: 'injected-by-model' },
    });
    expect(out.params.prompt).toBe('a drone shot over a canyon at dawn');
  });

  it('keeps the duration a number on the wire', () => {
    // The provider rejects a stringified duration; this is the last point the
    // type could be lost before the request leaves.
    expect(buildVideoTaskPayload(BASE).params.duration).toBe(8);
  });

  it('treats a node with no lease as gen 1', () => {
    const { leaseGen: _leaseGen, ...noLease } = BASE;
    expect(buildVideoTaskPayload(noLease).node_gens).toEqual({ 'node-1': 1 });
  });
});
