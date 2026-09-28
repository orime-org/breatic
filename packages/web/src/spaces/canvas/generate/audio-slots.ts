// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The source slots the audio panel offers (#1960, #2156).
 *
 * Their shape is {@link SlotSpec}, the same one the video registry uses — a
 * slot is a pick-time copy of one asset with a role, whichever panel offers
 * it, and two copies of that definition would be two places to remember when
 * a slot grows a field.
 *
 * Which of them a mode can draw is its row in `AUDIO_MODE_OPTIONS`; which of
 * those a run collects is the model's to say, read off its `fill` and `modes`
 * declarations by {@link audioSlotsForModel} below. One param can be two
 * places: `audio` is the voice sample under Voice Cloning and the song to
 * cover under Reference to Music.
 *
 * The reference rail is a different thing and stays where it is: a reference
 * is an edge between two nodes, a slot is a value copied onto this one.
 */

import { PANEL_EDITOR_PARAM, missingSources } from '@breatic/shared';
import type { MissingSource, ModelEntry } from '@breatic/shared';
import { AudioLines, Clapperboard, Image, Mic, Music2, Music4 } from 'lucide-react';

import { audioModeOption } from '@web/spaces/canvas/generate/audio-mode-options';
import type { SlotSpec } from '@web/spaces/canvas/generate/slots';
import { filledFromCanvas } from '@web/spaces/canvas/generate/canvas-filled';

/** The source slots the audio panel knows how to offer. */
export type AudioSlot =
  | 'refAudio'
  | 'soundVideo'
  | 'moodImage'
  | 'musicSong'
  | 'coverSong'
  | 'musicMelody'
  | 'musicVocal';

// Every slot taking something other than an image carries `storesCover`: an
// audio or video node's poster is what the button paints, and an audio node
// has none, so the stored value is `{url}` and the button keeps its own icon
// and label and lights its border (#1946, user 2026-09-06).

/** Every audio slot, by name. */
export const AUDIO_SLOTS = {
  refAudio: {
    field: 'refAudio',
    storesCover: true,
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
    errorKey: 'canvas.generatePanel.errorNoRefAudio',
  },
  // The picture a run is scored or sounded to: Sound Effects and Reference to
  // Music both take `video`, and read it the same way, so one slot serves
  // both rows. Its words are the video panel's source-video slot's.
  soundVideo: {
    field: 'soundVideo',
    storesCover: true,
    param: 'video',
    purpose: 'soundVideo',
    accepts: 'video',
    Icon: Clapperboard,
    testId: 'generate-audio-tool-sound-video',
    thumbnailTestId: 'generate-audio-sound-video-thumbnail',
    clearTestId: 'generate-audio-sound-video-clear',
    labelKey: 'canvas.generatePanel.sourceVideo',
    tipKey: 'canvas.generatePanel.sourceVideoTip',
    clearLabelKey: 'canvas.generatePanel.removeSourceVideo',
    errorKey: 'canvas.generatePanel.errorNoSourceVideo',
  },
  moodImage: {
    field: 'moodImageUrl',
    param: 'image',
    purpose: 'moodImage',
    accepts: 'image',
    Icon: Image,
    testId: 'generate-audio-tool-mood-image',
    thumbnailTestId: 'generate-audio-mood-image-thumbnail',
    clearTestId: 'generate-audio-mood-image-clear',
    labelKey: 'canvas.generatePanel.moodImage',
    tipKey: 'canvas.generatePanel.moodImageTip',
    clearLabelKey: 'canvas.generatePanel.removeMoodImage',
  },
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
    errorKey: 'canvas.generatePanel.errorNoMusicSong',
  },
  // The song a cover is made of. Called what the reader calls it — a song —
  // under the vendor's own name for the field, `audio`.
  coverSong: {
    field: 'coverSong',
    storesCover: true,
    param: 'audio',
    purpose: 'coverSong',
    accepts: 'audio',
    Icon: Music4,
    testId: 'generate-audio-tool-cover-song',
    thumbnailTestId: 'generate-audio-cover-song-thumbnail',
    clearTestId: 'generate-audio-cover-song-clear',
    labelKey: 'canvas.generatePanel.musicSong',
    tipKey: 'canvas.generatePanel.coverSongTip',
    clearLabelKey: 'canvas.generatePanel.removeMusicSong',
    errorKey: 'canvas.generatePanel.errorNoMusicSong',
  },
  musicMelody: {
    field: 'musicMelody',
    storesCover: true,
    param: 'melody',
    purpose: 'musicMelody',
    accepts: 'audio',
    Icon: Music2,
    testId: 'generate-audio-tool-music-melody',
    thumbnailTestId: 'generate-audio-music-melody-thumbnail',
    clearTestId: 'generate-audio-music-melody-clear',
    labelKey: 'canvas.generatePanel.musicMelody',
    tipKey: 'canvas.generatePanel.musicMelodyTip',
    clearLabelKey: 'canvas.generatePanel.removeMusicMelody',
  },
  musicVocal: {
    field: 'musicVocal',
    storesCover: true,
    param: 'vocal',
    purpose: 'musicVocal',
    accepts: 'audio',
    Icon: Mic,
    testId: 'generate-audio-tool-music-vocal',
    thumbnailTestId: 'generate-audio-music-vocal-thumbnail',
    clearTestId: 'generate-audio-music-vocal-clear',
    labelKey: 'canvas.generatePanel.musicVocal',
    tipKey: 'canvas.generatePanel.musicVocalTip',
    clearLabelKey: 'canvas.generatePanel.removeMusicVocal',
  },
} as const satisfies Record<AudioSlot, SlotSpec>;

/**
 * One URL per slot. Absent means this map has nothing for that slot — which
 * does NOT by itself mean the slot is empty: the panel builds two of these,
 * one for the picked assets and one for the pictures to show, and a filled
 * slot whose asset an `<img>` cannot paint is absent from the second.
 */
export type AudioSlotUrls = Partial<Record<AudioSlot, string>>;


/**
 * The slots this model draws in this mode, in the order the toolbar shows.
 *
 * The mode's row lists every place it can take a source; the model draws the
 * ones it declares (#2156, design §6).
 * @param model - The model the run names.
 * @param mode - The mode it is set to.
 * @returns Those slots, in the row's order; none before a model resolves.
 */
export function audioSlotsForModel(
  model: ModelEntry | undefined,
  mode: string,
): AudioSlot[] {
  if (model === undefined) return [];
  return audioModeOption(mode).slots.filter(
    (slot) => filledFromCanvas(model.params[AUDIO_SLOTS[slot].param], mode) !== undefined,
  );
}

/**
 * What an audio run still needs, in the order the toolbar offers it.
 *
 * Which of its places a run cannot go without is the model's to say, through
 * `missingSources` — the rule the server re-checks before enqueue.
 * @param model - The model the run names.
 * @param mode - The mode it is set to.
 * @param slotUrls - What the node's slots hold.
 * @returns Each unmet requirement; empty when the run has what it needs or no
 *   model resolves.
 */
export function audioMissing(
  model: ModelEntry | undefined,
  mode: string,
  slotUrls: AudioSlotUrls,
): MissingSource[] {
  if (model === undefined) return [];
  const params: Record<string, unknown> = {};
  for (const slot of audioSlotsForModel(model, mode)) {
    params[AUDIO_SLOTS[slot].param] = slotUrls[slot];
  }
  return missingSources(model, mode, params);
}

/**
 * Whether this run has a lyrics box beside its prompt.
 *
 * The model declares the words to sing as a parameter the panel keeps in a
 * text box of its own, so a music model that takes none simply has no box.
 * @param model - The model the run names.
 * @param mode - The mode it is set to.
 * @returns True when the panel opens a second box.
 */
export function modelTakesLyrics(model: ModelEntry | undefined, mode: string): boolean {
  const spec = model?.params?.[PANEL_EDITOR_PARAM];
  if (spec?.fill !== 'editor') return false;
  return spec.modes === undefined || spec.modes.includes(mode);
}
