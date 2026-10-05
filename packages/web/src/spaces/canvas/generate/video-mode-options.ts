// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The video modes the panel's mode picker offers, in display order, and the
 * sources each one collects.
 *
 * Text-to-video first — it is the default and the one that needs nothing.
 * The list grows one entry per slice, and each entry arrives stating which
 * slots the toolbar draws a control for, so a mode never appears before the
 * panel can collect what it needs.
 *
 * That list sits on the mode option rather than in a table of its own: which
 * slot a mode shows cannot be read off the declarations, because two slots
 * share one param (`image` is both a first frame and a character picture) and
 * the model says only that the param takes a picture. Whether the mode instead
 * takes the images the prompt `@`-mentions is read from the catalog
 * (`modelTakesReferences`), so a model that adds a reference pool reaches the
 * panel without an edit here.
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

/** The video modes offered so far. */
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
    // Every source comes from the rail: the pictures, clips and tracks the
    // model's pool takes, each named with `@` in the prompt (#2156).
    slots: [],
  },
  {
    value: 'multi_shot',
    label: 'Multi-Shot',
    testId: 'generate-video-mode-multi-shot',
    // Each shot gets its own prompt in place of the prompt box. An image to
    // video model keeps its first frame; the slot is drawn only for a model
    // declaring it (`videoSlotsForModel`), and a reference model's pool is
    // fed from the rail as in Reference to Video.
    slots: ['firstFrame'],
  },
  {
    value: 'talking_head',
    label: 'Talking Head',
    testId: 'generate-video-mode-talking-head',
    // The character image is the same slot image animation collects: both
    // modes want one picture of a person. The models under this mode collect
    // different sets — a portrait, a clip whose lips are redone, or two
    // speakers' tracks — and each draws only the ones it declares.
    slots: ['characterImage', 'sourceVideo', 'drivingAudio', 'leftAudio', 'rightAudio'],
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

