// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the canvas has to say — and where keyboard focus goes back to — for
 * each kind of pick.
 *
 * One table rather than a ternary at each site, because those sites drift:
 * adding the first-frame pick (#1902) extended the candidate-dimming rule and
 * the click handler but silently missed the banner and the focus hand-off, so
 * a first-frame pick told the user to "select a reference" and exited into
 * nowhere. The end frame (#1904) was the first slot to arrive after that.
 * `satisfies Record<PickPurpose, …>` turns the next omission into a compile
 * error instead of a wrong sentence on screen.
 *
 * A slot pick's trigger id is READ from the slot registry rather than written
 * again here. The toolbar renders that same entry, so the id this table
 * searches for and the id on screen are one string: written twice they agreed
 * by luck, and a typo in either was invisible — every canvas suite stayed
 * green while Exit dropped a keyboard user on the canvas container, which is
 * the miss above happening a second time.
 */

import { miniToolById } from '@breatic/shared/mini-tools';

import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { STYLE_SLOT } from '@web/spaces/canvas/generate/style-slot';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import type { PickPurpose, PickSession } from '@web/stores/canvas-session';

/** The panel kinds that own pick tools (the other panel kinds start none). */
type PickingPanelKind = 'generate' | 'generateVideo' | 'generateAudio';

interface PickPurposeUi {
  /** Translation key for the pick banner's instruction. */
  banner: string;
  /**
   * Test id of the tool that starts this pick, per panel. Focus returns there
   * when the banner unmounts. Partial on purpose: most purposes belong to one
   * panel — the source slots split by panel, with
   * both frames, the character image, the driving video and the driving audio
   * on the video panel and the voice sample and the three music references on
   * the audio one. Focus is the image and video panels'; reference is every
   * panel's, the audio one included.
   */
  trigger: Partial<Record<PickingPanelKind, string>>;
}

/** Banner copy + focus target for every pick purpose. */
export const PICK_PURPOSE_UI = {
  reference: {
    banner: 'canvas.generatePanel.selectFromCanvas',
    trigger: {
      generate: 'generate-tool-reference',
      generateVideo: 'generate-video-tool-reference',
      generateAudio: 'generate-audio-tool-reference',
    },
  },
  focus: {
    banner: 'canvas.generatePanel.selectFocusFromCanvas',
    trigger: {
      generate: 'generate-tool-focus',
      generateVideo: 'generate-video-tool-focus',
    },
  },
  firstFrame: {
    banner: 'canvas.generatePanel.selectFirstFrameFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.firstFrame.testId },
  },
  endFrame: {
    banner: 'canvas.generatePanel.selectEndFrameFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.endFrame.testId },
  },
  characterImage: {
    banner: 'canvas.generatePanel.selectCharacterImageFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.characterImage.testId },
  },
  drivingVideo: {
    banner: 'canvas.generatePanel.selectDrivingVideoFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.drivingVideo.testId },
  },
  drivingAudio: {
    banner: 'canvas.generatePanel.selectDrivingAudioFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.drivingAudio.testId },
  },
  sourceVideo: {
    banner: 'canvas.generatePanel.selectSourceVideoFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.sourceVideo.testId },
  },
  leftAudio: {
    banner: 'canvas.generatePanel.selectLeftAudioFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.leftAudio.testId },
  },
  rightAudio: {
    banner: 'canvas.generatePanel.selectRightAudioFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.rightAudio.testId },
  },
  refAudio: {
    banner: 'canvas.generatePanel.selectRefAudioFromCanvas',
    trigger: { generateAudio: AUDIO_SLOTS.refAudio.testId },
  },
  musicSong: {
    banner: 'canvas.generatePanel.selectMusicSongFromCanvas',
    trigger: { generateAudio: AUDIO_SLOTS.musicSong.testId },
  },
  coverSong: {
    banner: 'canvas.generatePanel.selectCoverSongFromCanvas',
    trigger: { generateAudio: AUDIO_SLOTS.coverSong.testId },
  },
  musicMelody: {
    banner: 'canvas.generatePanel.selectMusicMelodyFromCanvas',
    trigger: { generateAudio: AUDIO_SLOTS.musicMelody.testId },
  },
  musicVocal: {
    banner: 'canvas.generatePanel.selectMusicVocalFromCanvas',
    trigger: { generateAudio: AUDIO_SLOTS.musicVocal.testId },
  },
  soundVideo: {
    banner: 'canvas.generatePanel.selectSoundVideoFromCanvas',
    trigger: { generateAudio: AUDIO_SLOTS.soundVideo.testId },
  },
  moodImage: {
    banner: 'canvas.generatePanel.selectMoodImageFromCanvas',
    trigger: { generateAudio: AUDIO_SLOTS.moodImage.testId },
  },
  style: {
    banner: 'canvas.generatePanel.selectStyleFromCanvas',
    trigger: { generate: STYLE_SLOT.testId, generateVideo: STYLE_SLOT.testId },
  },
} as const satisfies Record<Exclude<PickPurpose, 'miniToolSlot'>, PickPurposeUi>;

/** What a running pick shows and where focus goes back to when it ends. */
export interface PickSessionUi {
  /** Translation key for the pick banner's instruction. */
  banner: string;
  /** Test ids of the tools that may have started it. */
  triggers: string[];
}

/**
 * Test id of a mini-tool slot's pick button (inner#888 §7.3).
 * @param toolId - The tool.
 * @param slotKey - The slot.
 * @returns The id.
 */
export function miniToolSlotTestId(toolId: string, slotKey: string): string {
  return `mini-tool-slot-${toolId}-${slotKey}`;
}

/**
 * The banner and triggers of a running pick. A mini-tool slot pick reads both
 * off the tool's slot, since the table above has one row per purpose and a
 * mini-tool has a slot per tool.
 * @param session - The pick.
 * @param miniToolId - The open mini-tool panel's tool, if one is open.
 * @returns Its banner key and trigger ids; the generic reference banner when
 *   a slot pick has lost its tool (the panel closed under it).
 */
export function pickSessionUi(session: PickSession, miniToolId: string | undefined): PickSessionUi {
  if (session.purpose !== 'miniToolSlot') {
    const row = PICK_PURPOSE_UI[session.purpose];
    return { banner: row.banner, triggers: Object.values(row.trigger) };
  }
  const slot = miniToolId === undefined
    ? undefined
    : miniToolById(miniToolId)?.slots.find((candidate) => candidate.key === session.slotKey);
  if (miniToolId === undefined || slot === undefined) {
    return { banner: PICK_PURPOSE_UI.reference.banner, triggers: [] };
  }
  return { banner: slot.bannerKey, triggers: [miniToolSlotTestId(miniToolId, slot.key)] };
}
