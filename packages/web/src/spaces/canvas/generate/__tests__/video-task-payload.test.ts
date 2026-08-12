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

  it('sends image animation the character image and the driving video', () => {
    // The upstream needs both: the motion comes from the video and is
    // transferred onto the character, so the server gate asks for both too
    // (source-requirement maps `animate` to `["image", "video"]`).
    const out = buildVideoTaskPayload({
      ...BASE,
      mode: 'animate',
      slotUrls: {
        characterImage: 'https://cdn/character.png',
        drivingVideo: 'https://cdn/driving.mp4',
      },
    });
    expect(out.params).toMatchObject({
      image: 'https://cdn/character.png',
      video: 'https://cdn/driving.mp4',
    });
    // The poster is ours, for showing the pick on the toolbar. The upstream
    // takes the video itself and knows nothing about a cover.
    expect(out.params).not.toHaveProperty('cover');
    expect(out.params).not.toHaveProperty('end_image');
  });

  it('sends the talking head its character image and its audio (#1935)', () => {
    // Upstream takes exactly two things and both are required: the portrait
    // to animate and the track its lips follow (checked against WaveSpeed's
    // API and model pages, 2026-08-12). The server gate asks for both too
    // (source-requirement maps `talking_head` to `["image", "audio"]`).
    const out = buildVideoTaskPayload({
      ...BASE,
      mode: 'talking_head',
      slotUrls: {
        characterImage: 'https://cdn/portrait.png',
        drivingAudio: 'https://cdn/speech.mp3',
        // The driving VIDEO is image animation's slot, and a pick survives a
        // mode switch — so a node arriving here really can still hold one.
        // Seeded rather than assumed away: without it the assertion below
        // would hold for any implementation, including one that ignores the
        // mode entirely.
        drivingVideo: 'https://cdn/driving.mp4',
      },
    });
    expect(out.params).toMatchObject({
      image: 'https://cdn/portrait.png',
      audio: 'https://cdn/speech.mp3',
    });
    expect(out.params).not.toHaveProperty('video');
  });

  it('carries the talking head no audio when none was picked', () => {
    // The refusal for a missing slot is the execute gate's job; the payload
    // must not invent a key, or the server gate would see a complete request.
    const out = buildVideoTaskPayload({
      ...BASE,
      mode: 'talking_head',
      slotUrls: { characterImage: 'https://cdn/portrait.png' },
    });
    expect(out.params).not.toHaveProperty('audio');
  });

  it('does not let a first frame picked elsewhere stand in as the character', () => {
    // A pick survives a mode switch, so a node arriving in image animation
    // can still be holding the first frame it was given in image-to-video.
    // The two are separate slots; that one is not this mode's character.
    const out = buildVideoTaskPayload({
      ...BASE,
      mode: 'animate',
      slotUrls: {
        firstFrame: 'https://cdn/first.png',
        drivingVideo: 'https://cdn/driving.mp4',
      },
    });
    expect(out.params).not.toHaveProperty('image');
    expect(out.params).toMatchObject({ video: 'https://cdn/driving.mp4' });
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

/**
 * #1927 — the reference images travel as `params.images`, and only for the
 * mode that asked for them.
 *
 * Same rule the slots follow: the field set is built FROM the mode, so a mode
 * that does not take references has no way to put an `images` key on the
 * payload and needs no check to keep it out. That matters more here than it
 * did for the slots — a reference stays connected across a mode switch, so
 * without this an image someone connected for reference-to-video would ride
 * along into a first-last-frame task.
 */
describe('buildVideoTaskPayload — reference images (#1927)', () => {
  const REFS = ['https://cdn/a.png', 'https://cdn/b.png'];

  it('sends reference-to-video the @-picked images, in order', () => {
    const out = buildVideoTaskPayload({
      ...BASE,
      mode: 'ref',
      referenceUrls: REFS,
    });
    expect(out.params).toMatchObject({ images: REFS });
  });

  it('leaves no `images` key on a mode that does not take references', () => {
    for (const mode of ['t2v', 'i2v', 'first_last', 'animate']) {
      const out = buildVideoTaskPayload({
        ...BASE,
        mode,
        slotUrls: {
          firstFrame: 'https://cdn/first.png',
          endFrame: 'https://cdn/last.png',
          characterImage: 'https://cdn/character.png',
          drivingVideo: 'https://cdn/driving.mp4',
        },
        referenceUrls: REFS,
      });
      expect(out.params, mode).not.toHaveProperty('images');
    }
  });

  it('leaves no `images` key when nothing is @-picked', () => {
    // The execute gate refuses this submit, so the builder never sees it in
    // practice; an empty key would still be wrong — upstream reads a source
    // field's presence, so an empty list is a claim of its own.
    const out = buildVideoTaskPayload({ ...BASE, mode: 'ref', referenceUrls: [] });
    expect(out.params).not.toHaveProperty('images');
  });

  it('never folds a slot URL into the reference array', () => {
    // The two are different things to the model, and a mode takes one kind or
    // the other — never both.
    const out = buildVideoTaskPayload({
      ...BASE,
      mode: 'ref',
      slotUrls: { firstFrame: 'https://cdn/first.png' },
      referenceUrls: REFS,
    });
    expect(out.params).toMatchObject({ images: REFS });
    expect(out.params).not.toHaveProperty('image');
  });
});

/**
 * What the payload really says about `images` when nothing is `@`-picked.
 *
 * The source-param builder adds no key — but it is not the only writer. The
 * model's own declared params arrive first (`resolveParamsForModel` fills a
 * value for every param the model declares, and `kling-o3-pro-ref` declares
 * `images` with a null default), so the payload can carry the key without the
 * builder ever touching it. Pinned here because the cases above cannot see it:
 * their `BASE.params` never carries the key production always carries.
 */
describe('buildVideoTaskPayload — the model brings its own `images` key', () => {
  const WITH_DECLARED = {
    ...BASE,
    params: { ...BASE.params, images: null },
  };

  it('overwrites the declared null with the @-picked list', () => {
    const out = buildVideoTaskPayload({
      ...WITH_DECLARED,
      mode: 'ref',
      referenceUrls: ['https://cdn/a.png'],
    });
    expect(out.params).toMatchObject({ images: ['https://cdn/a.png'] });
  });

  it('leaves the declared null alone when nothing is @-picked', () => {
    // Not "no key": the key is the model's, and stripping it here would be a
    // special case for one param among many that arrive the same way (`seed`,
    // `generate_audio`). Upstream is unbothered — the worker drops null values
    // before mapping and the server's source gate wants a non-empty array.
    const out = buildVideoTaskPayload({ ...WITH_DECLARED, mode: 'ref', referenceUrls: [] });
    expect(out.params.images).toBeNull();
  });

  it('leaves it alone under a mode that does not take references', () => {
    const out = buildVideoTaskPayload({
      ...WITH_DECLARED,
      mode: 't2v',
      referenceUrls: ['https://cdn/a.png'],
    });
    expect(out.params.images).toBeNull();
  });
});
