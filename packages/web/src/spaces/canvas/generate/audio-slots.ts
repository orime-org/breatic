// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The source slots the audio panel offers (#1960).
 *
 * Four: the voice to clone, and the three references a song can be written
 * after. Their shape is {@link SlotSpec}, the same one the video registry uses
 * — a slot is a pick-time copy of one asset with a role, whichever panel
 * offers it, and two copies of that definition would be two places to remember
 * when a slot grows a field.
 *
 * Which of them a mode collects is stated on the mode, not here
 * (`audio-mode-options.ts`): this table says what each slot IS, and a slot
 * belongs to no mode by living in it.
 *
 * The reference rail is a different thing and stays where it is: a reference
 * is an edge between two nodes, a slot is a value copied onto this one.
 */

import { AudioLines, Disc3, Mic, Music4 } from 'lucide-react';

import type { SlotSpec } from '@web/spaces/canvas/generate/slots';

/** The source slots the audio panel knows how to offer. */
export type AudioSlot =
  | 'refAudio'
  | 'musicSong'
  | 'musicVoice'
  | 'musicInstrumental';

/** Every audio slot, by name. */
export const AUDIO_SLOTS = {
  refAudio: {
    field: 'refAudio',
    // `storesCover` because audio is not an image, which is the whole test
    // this flag applies. An audio node carries no poster of its own, so the
    // stored value is `{url}` and the toolbar covers the button with the audio
    // node's icon instead of a thumbnail (#1946).
    storesCover: true,
    // qwen3-tts/voice-clone reads the reference URL as `audio`.
    param: 'audio',
    purpose: 'refAudio',
    accepts: 'audio',
    Icon: AudioLines,
    testId: 'generate-audio-tool-ref-audio',
    thumbnailTestId: 'generate-audio-ref-audio-thumbnail',
    clearTestId: 'generate-audio-ref-audio-clear',
    labelKey: 'canvas.generatePanel.refAudio',
    tipKey: 'canvas.generatePanel.refAudioTip',
    clearLabelKey: 'canvas.generatePanel.removeRefAudio',
    // No `errorKey`: this panel reaches every refusal sentence through
    // `refusalToastKey`, so a copy here would be a second place to change and
    // a first place to forget.
  },
  // The three below are what reference-to-music collects. They carry
  // `storesCover` for the same reason the voice sample does — audio paints no
  // thumbnail — and the vendor's own names for the params: minimax/music-01
  // reads `song`, `voice` and `instrumental`. The names come from WaveSpeed's
  // parameter page; `song` is the one that has been run against the gateway
  // (2026-09-05), so a run carrying only `voice` or only `instrumental` is
  // taken on the page's word.
  musicSong: {
    field: 'musicSong',
    storesCover: true,
    param: 'song',
    purpose: 'musicSong',
    accepts: 'audio',
    Icon: Music4,
    testId: 'generate-audio-tool-music-song',
    thumbnailTestId: 'generate-audio-music-song-thumbnail',
    clearTestId: 'generate-audio-music-song-clear',
    labelKey: 'canvas.generatePanel.musicSong',
    tipKey: 'canvas.generatePanel.musicSongTip',
    clearLabelKey: 'canvas.generatePanel.removeMusicSong',
  },
  musicVoice: {
    field: 'musicVoice',
    storesCover: true,
    param: 'voice',
    purpose: 'musicVoice',
    accepts: 'audio',
    Icon: Mic,
    testId: 'generate-audio-tool-music-voice',
    thumbnailTestId: 'generate-audio-music-voice-thumbnail',
    clearTestId: 'generate-audio-music-voice-clear',
    labelKey: 'canvas.generatePanel.musicVoice',
    tipKey: 'canvas.generatePanel.musicVoiceTip',
    clearLabelKey: 'canvas.generatePanel.removeMusicVoice',
  },
  musicInstrumental: {
    field: 'musicInstrumental',
    storesCover: true,
    param: 'instrumental',
    purpose: 'musicInstrumental',
    accepts: 'audio',
    Icon: Disc3,
    testId: 'generate-audio-tool-music-instrumental',
    thumbnailTestId: 'generate-audio-music-instrumental-thumbnail',
    clearTestId: 'generate-audio-music-instrumental-clear',
    labelKey: 'canvas.generatePanel.musicInstrumental',
    tipKey: 'canvas.generatePanel.musicInstrumentalTip',
    clearLabelKey: 'canvas.generatePanel.removeMusicInstrumental',
  },
} as const satisfies Record<AudioSlot, SlotSpec>;

/**
 * One URL per slot. Absent means this map has nothing for that slot — which
 * does NOT by itself mean the slot is empty: the panel builds two of these,
 * one for the picked assets and one for the pictures to show, and a filled
 * slot whose asset an `<img>` cannot paint is absent from the second.
 */
export type AudioSlotUrls = Partial<Record<AudioSlot, string>>;
