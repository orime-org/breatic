// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type * as React from 'react';
import type { VideoToolInput } from '@breatic/shared/mini-tools';

/** A synchronously consumable frame from the current source and seek lifetime. */
export interface VideoTimelinePresentedFrame {
  sourceKey: string;
  sourceEpoch: number;
  seekEpoch: number;
  mediaTime: number;
  surface: HTMLVideoElement | HTMLCanvasElement;
}

/** The actual element and transport owned by one native or alpha presentation. */
export interface VideoTimelineDecoderBinding {
  element: HTMLVideoElement;
  sourceKey: string;
  sourceEpoch: number;
  original: { width: number; height: number };
  seek: (time: number) => void;
  play: () => Promise<void>;
  pause: () => void;
}

/** Allows the source owner to select native or alpha presentation from its manifest. */
export type VideoTimelineDecoderRenderer = (
  input: VideoToolInput,
  onBinding: (binding: VideoTimelineDecoderBinding | null, error?: unknown) => void,
  onPresentedFrame: (frame: VideoTimelinePresentedFrame) => void,
) => React.ReactNode;
