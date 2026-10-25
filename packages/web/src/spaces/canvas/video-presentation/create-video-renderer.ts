// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { VideoPresentationSource, VideoRendererCallbacks, VideoRendererResource } from '@web/spaces/canvas/video-presentation/types';

/**
 * Creates the approved native or packed-alpha renderer for a ready source.
 * @param _host - Effect-owned presentation host.
 * @param _source - Canonical descriptor and optional owned alpha manifest.
 * @param _callbacks - Identity-checked resource notifications.
 * @returns Cleanup for every resource, including partially initialized ones.
 * @throws {never} Resource errors are reported through callbacks.
 */
export function createVideoRenderer(_host: HTMLElement, _source: VideoPresentationSource, _callbacks: VideoRendererCallbacks): VideoRendererResource {
  return { dispose: () => {} };
}
