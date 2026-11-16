// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The icon each source slot shows while it is empty. The slot specs in
 * `@breatic/shared/canvas-model` are UI-free data, so the icon stays here,
 * keyed by the slot's name in its registry.
 */

import type { AudioSlot, ImageSlot, VideoSlot } from '@breatic/shared/canvas-model';
import { AudioLines, Clapperboard, Image, Mic, Music2, Music4, Palette, UserRound, Video, type LucideIcon } from 'lucide-react';

/** Icon shown while the slot is empty, by slot. */
export const SLOT_ICONS: Readonly<Record<VideoSlot | AudioSlot | ImageSlot, LucideIcon>> = {
  firstFrame: Image,
  endFrame: Image,
  characterImage: UserRound,
  drivingVideo: Video,
  drivingAudio: AudioLines,
  sourceVideo: Video,
  leftAudio: AudioLines,
  rightAudio: AudioLines,
  refAudio: AudioLines,
  soundVideo: Clapperboard,
  moodImage: Image,
  musicSong: Music4,
  coverSong: Music4,
  musicMelody: Music2,
  musicVocal: Mic,
  style: Palette,
};
