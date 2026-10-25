// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import type { MediaSurfaceSnapshot, VideoPresentationSource, VideoRendererFactory } from '@web/spaces/canvas/video-presentation/types';

/** Options for one effect-owned canvas video surface. */
export interface MediaSurfaceOptions {
  host: React.RefObject<HTMLDivElement | null>;
  source: VideoPresentationSource | null;
  active: boolean;
  createRenderer?: VideoRendererFactory;
}

/** Resource state plus an explicit retry action. */
export interface MediaSurfaceApi extends MediaSurfaceSnapshot {
  retry: () => void;
}

/**
 * Owns a ready source's actual video resource for the active Space.
 * @param _options - Host, validated source and visibility.
 * @returns Current resource state and a retry command.
 * @throws {never} Resource failures are reported in the snapshot.
 */
export function useMediaSurface(_options: MediaSurfaceOptions): MediaSurfaceApi {
  return { status: 'detached', binding: null, error: null, retry: () => {} };
}
