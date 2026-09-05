// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import type { ModelEntry } from '@breatic/shared';

import { buildAudioTaskPayload } from '@web/spaces/canvas/generate/audio-task-payload';

/**
 * A model in the given bucket.
 * @param name - Model id.
 * @param modality - The bucket the catalog stamped on it.
 * @returns A model entry.
 */
function model(name: string, modality: ModelEntry['modality']): ModelEntry {
  return {
    name,
    display_name: name,
    modality,
    mode: 'tts',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 0,
    generation_time: 0,
    takes_prompt: true,
    params: {},
    providers: [],
    sourcesByMode: {},
  };
}

const BASE = {
  nodeId: 'n1',
  projectId: 'p1',
  spaceId: 's1',
  params: {},
  promptText: 'Good evening.',
};

describe('buildAudioTaskPayload — the task type comes from the model', () => {
  it('sends tts for a model out of the tts bucket', () => {
    // The worker loads a different provider module per task type
    // (`dispatch.ts` has one case each for tts and audio), and this panel
    // serves both buckets — so a panel-wide constant would send one of them
    // to the wrong module.
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('elevenlabs-v3', 'tts'),
    });
    expect(payload.task_type).toBe('tts');
  });

  it('sends audio for a model out of the audio bucket', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('some-sfx', 'audio'),
    });
    expect(payload.task_type).toBe('audio');
  });

  it('carries the model id, not the bucket', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('fish-s2-pro', 'tts'),
    });
    expect(payload.model).toBe('fish-s2-pro');
  });
});

describe('buildAudioTaskPayload — what reaches the vendor', () => {
  it('sends the model\'s own params alongside the lines to speak', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('elevenlabs-v3', 'tts'),
      params: { voice_id: 'Alice', stability: 0.5 },
    });
    expect(payload.params).toEqual({
      voice_id: 'Alice',
      stability: 0.5,
      prompt: 'Good evening.',
    });
  });

  it('lets the typed lines win over a same-named catalog param', () => {
    // The catalog is untrusted collaborative-adjacent config; what the user
    // typed must never be silently replaced by it.
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('elevenlabs-v3', 'tts'),
      params: { prompt: 'from the catalog' },
    });
    expect(payload.params.prompt).toBe('Good evening.');
  });

  it('overwrites the node it was launched from, fenced by its lease', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('elevenlabs-v3', 'tts'),
      leaseGen: 4,
    });
    expect(payload.mode).toBe('overwrite');
    expect(payload.target_node_id).toBe('n1');
    expect(payload.node_gens).toEqual({ n1: 5 });
  });
});

/**
 * The picked reference audio, on its way to the vendor (#1960 PR2).
 *
 * Nothing carried it before: the video builder has `sourceParams`, this one had
 * only the model's params and the prompt. A cloning submit therefore reached
 * the server with no `audio`, and the server-side source gate refuses that
 * before the task row is even written — every single time, for a user who had
 * picked one.
 */
describe('buildAudioTaskPayload — the picked reference audio', () => {
  it('sends the slot URL under the name the vendor reads', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('qwen3-tts-voice-clone', 'tts'),
      slots: ['refAudio'],
      slotUrls: { refAudio: 'https://cdn.test/sample.m4a' },
    });
    expect(payload.params.audio).toBe('https://cdn.test/sample.m4a');
  });

  it('lets the picked audio win over a same-named catalog param', () => {
    // Same rule the prompt follows, and the reason the slot merge lands AFTER
    // the params spread: what the user picked is what gets sent.
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('qwen3-tts-voice-clone', 'tts'),
      params: { audio: 'from the catalog' },
      slots: ['refAudio'],
      slotUrls: { refAudio: 'https://cdn.test/sample.m4a' },
    });
    expect(payload.params.audio).toBe('https://cdn.test/sample.m4a');
  });

  it('leaves a pick behind when the active mode does not collect it', () => {
    // A pick survives a mode switch by design — it lives on the node, not in
    // the panel — so text to speech reads a reference audio chosen for cloning and
    // would send it as `params.audio` under a mode that never asked for one.
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('elevenlabs-v3', 'tts'),
      slots: [],
      slotUrls: { refAudio: 'https://cdn.test/sample.m4a' },
    });
    expect(payload.params).not.toHaveProperty('audio');
  });

  it('sends no audio key at all when nothing is picked', () => {
    // An `audio: undefined` riding along would read as a present-but-empty
    // source; the gate tests `typeof value === "string"`, so the key has to be
    // absent rather than blank.
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('qwen3-tts-voice-clone', 'tts'),
      slotUrls: {},
    });
    expect(payload.params).not.toHaveProperty('audio');
  });

  it('leaves the text-to-speech models untouched', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('elevenlabs-v3', 'tts'),
      params: { voice_id: 'Alice' },
    });
    expect(payload.params).toEqual({ voice_id: 'Alice', prompt: 'Good evening.' });
  });
});

/**
 * The two music models' contracts, measured against the gateway on 2026-09-05
 * (#1960 A10).
 *
 * `minimax/music-3.0` takes a style brief as `prompt` and words as `lyrics`,
 * and refuses the request outright without the latter — the gateway answered
 * `invalid params, lyrics is required` for an empty one. `minimax/music-01`
 * takes up to three reference tracks and accepts a `prompt` alongside them.
 */
describe('buildAudioTaskPayload — the music models (#1960)', () => {
  it('sends the style brief and the lyrics as two separate fields', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('minimax-music-3.0', 'audio'),
      promptText: 'warm indie folk, fingerpicked guitar, 90 BPM',
      lyricsText: '[Verse]\nMorning light across the kitchen floor',
    });
    expect(payload.params).toMatchObject({
      prompt: 'warm indie folk, fingerpicked guitar, 90 BPM',
      lyrics: '[Verse]\nMorning light across the kitchen floor',
    });
  });

  it('lets the written lyrics win over a same-named catalog param', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('minimax-music-3.0', 'audio'),
      params: { lyrics: 'from the catalog' },
      lyricsText: 'what the user wrote',
    });
    expect(payload.params.lyrics).toBe('what the user wrote');
  });

  it('sends no lyrics key on a mode that has no lyrics box', () => {
    // Text to speech and sound effects never collect them, so the field must
    // not appear at all rather than appear empty.
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('elevenlabs-v3', 'tts'),
    });
    expect(payload.params).not.toHaveProperty('lyrics');
  });

  it('sends an empty lyrics through on an instrumental track', () => {
    // Measured 2026-09-05: `is_instrumental: true` with an empty `lyrics` is
    // accepted and completes, and it is the only empty case the panel can
    // build — both music models refuse an empty one on a vocal run. Empty
    // stays empty rather than being dropped or filled with the style brief;
    // the user would hear their own "warm indie folk, 90 BPM" sung back.
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('minimax-music-3.0', 'audio'),
      params: { is_instrumental: true },
      lyricsText: '',
    });
    expect(payload.params.lyrics).toBe('');
    expect(payload.params.is_instrumental).toBe(true);
  });

  it('puts each of the three reference tracks under its own vendor name', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('minimax-music-01', 'audio'),
      slots: ['musicSong', 'musicVoice', 'musicInstrumental'],
      slotUrls: {
        musicSong: 'https://cdn/song.mp3',
        musicVoice: 'https://cdn/voice.mp3',
        musicInstrumental: 'https://cdn/backing.mp3',
      },
    });
    expect(payload.params).toMatchObject({
      song: 'https://cdn/song.mp3',
      voice: 'https://cdn/voice.mp3',
      instrumental: 'https://cdn/backing.mp3',
    });
  });

  it('sends only what was picked, on a mode where one is enough', () => {
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('minimax-music-01', 'audio'),
      slots: ['musicSong', 'musicVoice', 'musicInstrumental'],
      slotUrls: { musicVoice: 'https://cdn/voice.mp3' },
    });
    expect(payload.params).toMatchObject({ voice: 'https://cdn/voice.mp3' });
    expect(payload.params).not.toHaveProperty('song');
    expect(payload.params).not.toHaveProperty('instrumental');
  });

  it('leaves a voice sample behind, which music never asked for', () => {
    // The cloning pick survives a mode switch by design. It is not one of the
    // three this mode collects, so it must not travel as one.
    const payload = buildAudioTaskPayload({
      ...BASE,
      model: model('minimax-music-01', 'audio'),
      slots: ['musicSong', 'musicVoice', 'musicInstrumental'],
      slotUrls: { refAudio: 'https://cdn/sample.mp3' },
    });
    expect(payload.params).not.toHaveProperty('audio');
  });
});
