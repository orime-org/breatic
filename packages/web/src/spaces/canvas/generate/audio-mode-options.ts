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
 * catalog buckets — voiceover and voice cloning in `tts`, sound effects and
 * music in `audio` — which is why the panel reads both (`modality-buckets`).
 *
 * Labels are English only, never localized (user 2026-07-10 item 15): these
 * are product mode names in the do-not-translate spirit of the DNT glossary,
 * so they read identically across all locales.
 */

import type { ModeOption } from '@web/spaces/canvas/generate/ModeToggle';

/** The audio modes offered so far. */
export const AUDIO_MODE_OPTIONS: ReadonlyArray<ModeOption> = [
  { value: 'tts', label: 'Voiceover', testId: 'generate-audio-mode-tts' },
];
