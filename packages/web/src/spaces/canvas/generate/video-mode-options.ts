// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The video modes the panel's mode picker offers, in display order, and the
 * source slots each one collects.
 *
 * Text-to-video first — it is the default and the one that needs nothing.
 * The list grows one entry per slice: image animation, reference-to-video and
 * talking head each arrive with the source slots they need, so a mode never
 * appears before the panel can collect what it takes.
 *
 * The slots sit on the mode option rather than in a table of their own,
 * because what a mode sends upstream is a fixed set of fields and everything
 * downstream is built from it — the toolbar's controls, the check before
 * execute, and the payload's source params. One list means adding a mode
 * cannot forget to state what it collects.
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
  /**
   * Whether this mode's sources are the reference images the prompt
   * `@`-mentions (#1927). Stated on every option rather than only on the one
   * that says yes: a reference stays connected across a mode switch, so a
   * mode that left this unsaid would be one whose payload nobody decided.
   */
  takesReferences: boolean;
}

/** The video modes offered so far (#1896 slices 1 to 5). */
export const VIDEO_MODE_OPTIONS: ReadonlyArray<VideoModeOption> = [
  {
    value: 't2v',
    label: 'Text to Video',
    testId: 'generate-video-mode-t2v',
    slots: [],
    takesReferences: false,
  },
  {
    value: 'i2v',
    label: 'Image to Video',
    testId: 'generate-video-mode-i2v',
    slots: ['firstFrame'],
    takesReferences: false,
  },
  {
    value: 'first_last',
    label: 'First-Last Frame',
    testId: 'generate-video-mode-first-last',
    slots: ['firstFrame', 'endFrame'],
    takesReferences: false,
  },
  {
    value: 'animate',
    label: 'Image Animation',
    testId: 'generate-video-mode-animate',
    slots: ['characterImage', 'drivingVideo'],
    takesReferences: false,
  },
  {
    value: 'ref',
    label: 'Reference to Video',
    testId: 'generate-video-mode-ref',
    // No slots at all — the first mode whose sources come from the reference
    // rail instead of a control the toolbar renders.
    slots: [],
    takesReferences: true,
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

/**
 * Whether a mode's sources are the `@`-mentioned reference images (#1927).
 *
 * One statement, three readers: the payload puts the picked URLs in `images`
 * only for a mode that says yes, the execute gate checks how many were picked
 * only for that mode, and the rail dims its image rows for every mode that
 * says no. Deriving it from the mode list rather than from a model's declared
 * params is what keeps the four slot-collecting modes untouched — they take
 * their sources through controls, whatever their model happens to declare.
 * @param mode - The active mode.
 * @returns True only for a mode this panel offers that collects references.
 */
export function modeTakesReferences(mode: string): boolean {
  return (
    VIDEO_MODE_OPTIONS.find((o) => o.value === mode)?.takesReferences ?? false
  );
}
