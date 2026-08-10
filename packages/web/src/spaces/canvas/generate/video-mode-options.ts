// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The video modes the panel's mode picker offers, in display order.
 *
 * Text-to-video first — it is the default and the one that needs nothing.
 * The list grows one entry per slice: first-last frame, image animation,
 * reference-to-video and talking head each arrive with the source slot they
 * need, so a mode never appears before the panel can collect what it takes.
 *
 * Labels are English only, never localized (user 2026-07-10 item 15): these
 * are product mode names in the do-not-translate spirit of the DNT glossary,
 * so they read identically across all locales.
 */

import type { ModeOption } from '@web/spaces/canvas/generate/ModeToggle';

/** The video modes offered today (#1896 slices 1 and 2). */
export const VIDEO_MODE_OPTIONS: ReadonlyArray<ModeOption> = [
  { value: 't2v', label: 'Text to Video', testId: 'generate-video-mode-t2v' },
  { value: 'i2v', label: 'Image to Video', testId: 'generate-video-mode-i2v' },
];
