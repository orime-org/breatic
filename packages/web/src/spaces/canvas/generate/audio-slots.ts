// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The source slots the audio panel offers (#1960 PR2).
 *
 * One so far: the voice to clone. Its shape is {@link SlotSpec}, the same one
 * the video registry uses — a slot is a pick-time copy of one asset with a
 * role, whichever panel offers it, and two copies of that definition would be
 * two places to remember when a slot grows a field.
 *
 * The reference rail is a different thing and stays where it is: a reference
 * is an edge between two nodes, a slot is a value copied onto this one.
 */

import { AudioLines } from 'lucide-react';

import type { SlotSpec } from '@web/spaces/canvas/generate/slots';

/** The source slots the audio panel knows how to offer. */
export type AudioSlot = 'refAudio';

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
    errorKey: 'canvas.generatePanel.errorNoRefAudio',
  },
} as const satisfies Record<AudioSlot, SlotSpec>;

/**
 * One URL per slot. Absent means this map has nothing for that slot — which
 * does NOT by itself mean the slot is empty: the panel builds two of these,
 * one for the picked assets and one for the pictures to show, and a filled
 * slot whose asset an `<img>` cannot paint is absent from the second.
 */
export type AudioSlotUrls = Partial<Record<AudioSlot, string>>;
