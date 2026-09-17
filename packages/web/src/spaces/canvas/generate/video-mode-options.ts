// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The video modes the panel's mode picker offers, in display order, and the
 * sources each one collects.
 *
 * Text-to-video first — it is the default and the one that needs nothing.
 * The list grows one entry per slice, and each entry arrives stating what it
 * collects, so a mode never appears before the panel can collect it. There are
 * two ways to state that: the slots the toolbar renders a control for, and —
 * since reference-to-video (#1927) — whether the mode takes the images the
 * prompt `@`-mentions instead.
 *
 * Both sit on the mode option rather than in a table of their own, because
 * what a mode sends upstream is a fixed set of fields and everything
 * downstream is built from it — the toolbar's controls, the check before
 * execute, the payload's source params, and the rail's dimming. One list means
 * adding a mode cannot forget to state what it collects.
 *
 * Labels are English only, never localized (user 2026-07-10 item 15): these
 * are product mode names in the do-not-translate spirit of the DNT glossary,
 * so they read identically across all locales.
 */

import type { ModeOption } from '@web/spaces/canvas/generate/ModeToggle';
import type { VideoSlot } from '@web/spaces/canvas/generate/video-slots';

/** A video mode option: a mode plus the sources it collects. */
export interface VideoModeOption extends ModeOption {
  /** The slots this mode collects, in the order the toolbar shows them. */
  slots: readonly VideoSlot[];
}

/** The video modes offered so far (#1896 slices 1 to 6). */
export const VIDEO_MODE_OPTIONS: ReadonlyArray<VideoModeOption> = [
  {
    value: 't2v',
    label: 'Text to Video',
    testId: 'generate-video-mode-t2v',
    slots: [],
  },
  {
    value: 'i2v',
    label: 'Image to Video',
    testId: 'generate-video-mode-i2v',
    slots: ['firstFrame'],
  },
  {
    value: 'first_last',
    label: 'First-Last Frame',
    testId: 'generate-video-mode-first-last',
    slots: ['firstFrame', 'endFrame'],
  },
  {
    value: 'animate',
    label: 'Image Animation',
    testId: 'generate-video-mode-animate',
    slots: ['characterImage', 'drivingVideo'],
  },
  {
    value: 'ref',
    label: 'Reference to Video',
    testId: 'generate-video-mode-ref',
    // The first mode taking both kinds at once: its reference images come from
    // the rail, and the one video the vendor reads for motion guidance is a
    // slot, because it is a single asset with a role rather than something the
    // prompt refers to. Optional, so the panel runs on the images alone.
    slots: ['referenceVideo'],
  },
  {
    value: 'talking_head',
    label: 'Talking Head',
    testId: 'generate-video-mode-talking-head',
    // The character image is the same slot image animation collects: both
    // modes want one picture of a person, and a slot shared across modes is
    // how the first frame already works. The driving audio is the first slot
    // in this panel that takes an audio node.
    slots: ['characterImage', 'drivingAudio'],
  },
];

/** No slots — shared so every "this mode collects nothing" answer is one array. */
const NO_SLOTS: readonly VideoSlot[] = [];

/**
 * The source slots a mode collects.
 *
 * A mode this panel does not offer collects nothing: the node's `mode` field
 * is shared with the image panel, so it can hold a value this panel never
 * shows, and collecting slots for it would render controls the submit ignores.
 * @param mode - The active mode.
 * @returns The mode's slots in display order; empty when it collects none.
 */
export function slotsForMode(mode: string): readonly VideoSlot[] {
  return VIDEO_MODE_OPTIONS.find((o) => o.value === mode)?.slots ?? NO_SLOTS;
}

