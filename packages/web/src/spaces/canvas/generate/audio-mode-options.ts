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
   * Both music modes demand them, measured against the gateway on 2026-09-05:
   * text-to-music answers `invalid params, lyrics is required`, and
   * reference-to-music answers `2013 - invalid params` both to an empty
   * `lyrics` and to a body carrying no `lyrics` key at all. The vendor page's
   * "leave empty for auto-generated lyrics" is not what either one does.
   *
   * `optional` therefore has no user today. It stays in the type because the
   * question it answers — does this mode SHOW a lyrics box — is a different
   * one from whether the box may be left empty, and a model whose upstream
   * writes its own words would be the third answer rather than a second
   * meaning for the absent case.
   *
   * Every other mode has no such box at all, which is why this is stated on
   * the mode rather than derived from the model.
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
    // Required here as well, and with no instrumental switch to lift it:
    // minimax/music-01 declares no such param, so every run it takes is a
    // vocal one.
    lyrics: 'required',
  },
];

/** The empty list, so a mode this panel does not offer answers one reference. */
const NO_SLOTS: readonly AudioSlot[] = [];

/** What a mode this panel does not offer collects and asks for: nothing. */
const NOT_OURS: AudioModeOption = {
  value: '',
  label: '',
  testId: 'generate-audio-mode-none',
  placeholderKey: 'canvas.generatePanel.audioPromptPlaceholder',
  slots: NO_SLOTS,
};

/**
 * The option behind a mode string.
 *
 * One lookup for every field rather than one function per field: the node's
 * `mode` is shared with the other panels, so it can hold a value this one
 * never shows, and each caller would otherwise repeat the same `find` and the
 * same answer for that case. What comes back for a mode this panel does not
 * offer collects nothing and asks for nothing, which is what a panel showing
 * no such mode should do.
 * @param mode - The active mode.
 * @returns Its option, or a collects-nothing stand-in.
 */
export function audioModeOption(mode: string): AudioModeOption {
  return AUDIO_MODE_OPTIONS.find((o) => o.value === mode) ?? NOT_OURS;
}
