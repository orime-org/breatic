// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { slotsForMode } from '@web/spaces/canvas/generate/video-mode-options';
import { buildVideoTaskPayload, videoEstimateInput } from '@web/spaces/canvas/generate/video-task-payload';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';

const BASE = {
  // A mode with no params scoped to other modes: nothing is left behind.
  generation: { mode: 't2v', declared: {} },
  nodeId: 'node-1',
  projectId: 'proj-1',
  spaceId: 'space-1',
  model: 'veo-3.1',
  params: { aspect_ratio: '16:9', resolution: '720p', duration: 8 },
  promptText: 'a drone shot over a canyon at dawn',
  slots: slotsForMode('t2v'),
  slotUrls: {},
  // Nothing mentioned, or a model that takes no pool: no pool params.
  poolParams: {},
  // Outside the multi-shot mode: no shot params.
  storyboardParams: {},
};

describe('buildVideoTaskPayload', () => {
  it('builds an overwrite payload targeting the node', () => {
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
      source: 'task',
      target_node_id: 'node-1',
      mode: 'overwrite',
    });
  });

  it('sends image-to-video the first frame, as the `image` param', () => {
    // The backend source gate reads it from `params.image`
    // (source-requirement.ts maps `i2v` to `["image"]`). It travels as its OWN
    // param, never folded into the reference array — that array is the
    // @-picked pool and means something different.
    const out = buildVideoTaskPayload({
      ...BASE,
      slots: slotsForMode('i2v'),
      slotUrls: { firstFrame: 'https://cdn/first.png' },
    });
    expect(out.params).toMatchObject({ image: 'https://cdn/first.png' });
    expect(out.params).not.toHaveProperty('end_image');
  });

  it('sends first-last frame both frames, under their own params', () => {
    const out = buildVideoTaskPayload({
      ...BASE,
      slots: slotsForMode('first_last'),
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
      slots: slotsForMode('animate'),
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
      slots: slotsForMode('talking_head'),
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
      slots: slotsForMode('talking_head'),
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
      slots: slotsForMode('animate'),
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
      slots: slotsForMode('i2v'),
      slotUrls: {
        firstFrame: 'https://cdn/first.png',
        endFrame: 'https://cdn/left-behind.png',
      },
    });
    expect(out.params).toMatchObject({ image: 'https://cdn/first.png' });
    expect(out.params).not.toHaveProperty('end_image');
  });

  it('carries only the slots the model draws, not a pick another model left behind', () => {
    // A lipsync model takes a clip and a track; a portrait picked for another
    // talking-head model stays on the node and must not ride along.
    const out = buildVideoTaskPayload({
      ...BASE,
      slots: ['sourceVideo', 'drivingAudio'],
      slotUrls: {
        characterImage: 'https://cdn/face.png',
        sourceVideo: 'https://cdn/clip.mp4',
        drivingAudio: 'https://cdn/line.mp3',
      },
    });
    expect(out.params).toMatchObject({ video: 'https://cdn/clip.mp4', audio: 'https://cdn/line.mp3' });
    expect(out.params).not.toHaveProperty('image');
  });

  it('omits a slot the mode collects but nobody filled', () => {
    // The upstream provider reads a source field's presence, not its value, so
    // an empty slot must leave no key behind.
    const out = buildVideoTaskPayload({ ...BASE, slots: slotsForMode('i2v'), slotUrls: {} });
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
});

/**
 * #1927, #2156 — the `@`-mentioned references travel under the params the
 * model reads each kind from. Which kinds a mode's model takes is decided
 * before the builder (the view model's pool); the builder writes what it is
 * handed, so a reference connected for another mode has no way in.
 */
describe('buildVideoTaskPayload — the storyboard (#2218)', () => {
  it('sends the prompt beside the automatic tier', () => {
    const out = buildVideoTaskPayload({ ...BASE, storyboardParams: { shot_type: 'intelligence' } });
    expect(out.params).toMatchObject({ prompt: BASE.promptText, shot_type: 'intelligence' });
  });

  it('sends the shots and no main prompt under the per-shot tier', () => {
    const shots = [{ prompt: 'a paper boat', duration: 5 }, { prompt: 'the pond', duration: 3 }];
    const out = buildVideoTaskPayload({
      ...BASE,
      promptText: undefined,
      storyboardParams: { shot_type: 'customize', multi_prompt: shots },
    });
    expect(out.params).toMatchObject({ shot_type: 'customize', multi_prompt: shots });
    expect(out.params).not.toHaveProperty('prompt');
  });
});

describe('buildVideoTaskPayload — the reference pool', () => {
  const REFS = ['https://cdn/a.png', 'https://cdn/b.png'];
  const CLIP = 'https://cdn/clip.mp4';

  it('sends each kind under the param the model reads it from, in order', () => {
    const out = buildVideoTaskPayload({
      ...BASE,
      slots: slotsForMode('ref'),
      poolParams: { images: REFS, videos: [CLIP] },
    });
    expect(out.params).toMatchObject({ images: REFS, videos: [CLIP] });
  });

  it('leaves no pool key when nothing is mentioned', () => {
    // An empty list would still be wrong — upstream reads a source field's
    // presence, so an empty list is a claim of its own.
    const out = buildVideoTaskPayload({ ...BASE, slots: slotsForMode('ref') });
    expect(out.params).not.toHaveProperty('images');
  });

  it('never folds a slot URL into the pool', () => {
    // Kling O3 takes a first frame through its slot and its elements through
    // the pool: two different things to the model.
    const out = buildVideoTaskPayload({
      ...BASE,
      slots: slotsForMode('i2v'),
      slotUrls: { firstFrame: 'https://cdn/first.png' },
      poolParams: { elements: REFS },
    });
    expect(out.params).toMatchObject({ image: 'https://cdn/first.png', elements: REFS });
  });
});

/**
 * What the payload really says about `images` when nothing is `@`-picked.
 *
 * The source-param builder adds no key — but it is not the only writer. The
 * model's own declared params arrive first (`resolveParamsForModel` fills a
 * value for every param the model declares), so the payload can carry the key
 * without the builder ever touching it.
 */
describe('buildVideoTaskPayload — the model brings its own `images` key', () => {
  const WITH_DECLARED = {
    ...BASE,
    params: { ...BASE.params, images: null },
  };

  it('overwrites the declared null with the @-picked list', () => {
    const out = buildVideoTaskPayload({
      ...WITH_DECLARED,
      slots: slotsForMode('ref'),
      poolParams: { images: ['https://cdn/a.png'] },
    });
    expect(out.params).toMatchObject({ images: ['https://cdn/a.png'] });
  });

  it('leaves the declared null alone when nothing is @-picked', () => {
    // Not "no key": the key is the model's, and stripping it here would be a
    // special case for one param among many that arrive the same way (`seed`,
    // `generate_audio`). The worker drops null values before mapping.
    const out = buildVideoTaskPayload({ ...WITH_DECLARED, slots: slotsForMode('ref') });
    expect(out.params.images).toBeNull();
  });
});

describe('videoEstimateInput — the run the price is quoted for', () => {
  it('carries the picked and mentioned sources with their lengths, as the submit sends them', () => {
    const input = videoEstimateInput(
      {
        params: { resolution: '720p' },
        slots: ['sourceVideo'],
        slotUrls: { sourceVideo: 'https://cdn/s.mp4' },
        pool: { video: { param: 'videos', cap: undefined } },
        referenceUrls: { image: [], video: ['https://cdn/r.mp4'], audio: [] },
        sourceDurations: { [VIDEO_SLOTS.sourceVideo.param]: [5], videos: [8] },
      },
      'a pan',
    );
    expect(input).toEqual({
      params: {
        resolution: '720p',
        [VIDEO_SLOTS.sourceVideo.param]: 'https://cdn/s.mp4',
        videos: ['https://cdn/r.mp4'],
      },
      prompt: 'a pan',
      durations: { [VIDEO_SLOTS.sourceVideo.param]: [5], videos: [8] },
    });
  });
});
