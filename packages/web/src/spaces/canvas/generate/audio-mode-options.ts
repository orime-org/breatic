// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The audio modes the panel's mode picker offers, in display order.
 *
 * Each `value` is the string the models spell in their yaml `mode` field:
 * availability is decided by matching the two, so a mode named anything else
 * is filtered out and never reaches the picker.
 *
 * The list grows one entry per slice, and the modes it will hold live in two
 * catalog buckets — text to speech and voice cloning in `tts`, sound effects
 * and music in `audio` — which is why the panel reads both
 * (`modality-buckets`).
 *
 * Labels are English only, never localized (user 2026-07-10 item 15): these
 * are product mode names in the do-not-translate spirit of the DNT glossary,
 * so they read identically across all locales.
 */

import type { AudioSlot } from '@web/spaces/canvas/generate/audio-slots';
import type { ModeOption } from '@web/spaces/canvas/generate/ModeToggle';

/** An audio mode, the sources it collects, and what its prompt box asks for. */
export interface AudioModeOption extends ModeOption {
  /**
   * The i18n key for what the prompt box asks for under this mode.
   *
   * It rides on the mode rather than being chosen in the container so that a
   * mode added later cannot reach the picker without one — a single panel-wide
   * string told someone writing a sound effect to write lines to speak.
   */
  placeholderKey: string;
  /**
   * The slots this mode collects, in the order the toolbar shows them.
   *
   * Stated per mode for the same reason the video panel states its own: a mode
   * added later cannot forget to say what it collects. It also replaces the
   * catalogue-driven rule this panel used to run — "does the selected model
   * declare an audio source for this mode" reads true for reference-to-music
   * as well, which would have offered the voice-sample slot on a music mode.
   */
  slots: readonly AudioSlot[];
  /**
   * Whether this mode collects lyrics alongside the prompt (#1960).
   *
   * Only text-to-music demands them — the gateway refuses that model outright
   * without them (`invalid params, lyrics is required`, measured 2026-09-05).
   * Reference-to-music takes them or not, and every other mode has no such box
   * at all, which is why this is stated on the mode rather than derived from
   * the model.
   */
  lyrics?: 'required' | 'optional';
}

/** The audio modes offered so far. */
export const AUDIO_MODE_OPTIONS: ReadonlyArray<AudioModeOption> = [
  {
    value: 'tts',
    label: 'Text to Speech',
    testId: 'generate-audio-mode-tts',
    placeholderKey: 'canvas.generatePanel.audioPromptPlaceholder',
    slots: [],
  },
  {
    value: 'voice_clone',
    label: 'Voice Cloning',
    testId: 'generate-audio-mode-voice-clone',
    // The same words as text to speech: both ask for lines to be spoken, and
    // the difference between them is whose voice speaks them.
    placeholderKey: 'canvas.generatePanel.audioPromptPlaceholder',
    slots: ['refAudio'],
  },
  {
    value: 'sfx',
    label: 'Sound Effects',
    testId: 'generate-audio-mode-sfx',
    placeholderKey: 'canvas.generatePanel.sfxPromptPlaceholder',
    slots: [],
  },
  {
    value: 't2m',
    label: 'Text to Music',
    testId: 'generate-audio-mode-t2m',
    // A style brief, not lines to speak — the words go in the lyrics box.
    placeholderKey: 'canvas.generatePanel.musicPromptPlaceholder',
    slots: [],
    lyrics: 'required',
  },
  {
    value: 'a2m',
    label: 'Reference to Music',
    testId: 'generate-audio-mode-a2m',
    placeholderKey: 'canvas.generatePanel.musicPromptPlaceholder',
    slots: ['musicSong', 'musicVoice', 'musicInstrumental'],
    lyrics: 'optional',
  },
];

/** The empty list, so `slotsForMode` returns one stable reference. */
const NO_SLOTS: readonly AudioSlot[] = [];

/**
 * The slots a mode collects, in display order.
 *
 * A mode this panel does not offer collects nothing: the node's `mode` field is
 * shared with the other panels, so it can hold a value this one never shows,
 * and collecting slots for it would render controls the submit ignores.
 * @param mode - The active mode.
 * @returns The mode's slots in display order; empty when it collects none.
 */
export function audioSlotsForMode(mode: string): readonly AudioSlot[] {
  return AUDIO_MODE_OPTIONS.find((o) => o.value === mode)?.slots ?? NO_SLOTS;
}

/**
 * Whether a mode collects lyrics, and whether it insists on them (#1960).
 * @param mode - The active mode.
 * @returns How this mode treats lyrics, or undefined when it has no such box.
 */
export function lyricsForMode(mode: string): 'required' | 'optional' | undefined {
  return AUDIO_MODE_OPTIONS.find((o) => o.value === mode)?.lyrics;
}
