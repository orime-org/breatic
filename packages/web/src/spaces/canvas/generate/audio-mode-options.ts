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

import type { ModeOption } from '@web/spaces/canvas/generate/ModeToggle';

/** An audio mode, and the prompt placeholder that belongs to it. */
export interface AudioModeOption extends ModeOption {
  /**
   * The i18n key for what the prompt box asks for under this mode.
   *
   * It rides on the mode rather than being chosen in the container so that a
   * mode added later cannot reach the picker without one — a single panel-wide
   * string told someone writing a sound effect to write lines to speak.
   */
  placeholderKey: string;
}

/** The audio modes offered so far. */
export const AUDIO_MODE_OPTIONS: ReadonlyArray<AudioModeOption> = [
  {
    value: 'tts',
    label: 'Text to Speech',
    testId: 'generate-audio-mode-tts',
    placeholderKey: 'canvas.generatePanel.audioPromptPlaceholder',
  },
  {
    value: 'voice_clone',
    label: 'Voice Cloning',
    testId: 'generate-audio-mode-voice-clone',
    // The same words as text to speech: both ask for lines to be spoken, and
    // the difference between them is whose voice speaks them.
    placeholderKey: 'canvas.generatePanel.audioPromptPlaceholder',
  },
  {
    value: 'sfx',
    label: 'Sound Effects',
    testId: 'generate-audio-mode-sfx',
    placeholderKey: 'canvas.generatePanel.sfxPromptPlaceholder',
  },
];
