// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { AlphaManifest, VideoPresentation } from '@breatic/shared';

/** A frame that the current renderer has actually drawn. */
export interface PresentedMediaFrame {
  sourceKey: string;
  sourceEpoch: number;
  seekEpoch: number;
  mediaTime: number;
  surface: HTMLVideoElement | HTMLCanvasElement;
}

/** The resource identity observed by existing canvas transport controls. */
export interface MediaSurfaceBinding {
  sourceKey: string;
  sourceEpoch: number;
  element: HTMLVideoElement;
  surface: HTMLVideoElement | HTMLCanvasElement;
  container: HTMLElement;
  original: VideoPresentation['original'];
  getSeekEpoch: () => number;
  getPresentedFrame: () => PresentedMediaFrame | null;
  seek: (seconds: number) => void;
  play: () => Promise<void>;
  pause: () => void;
}

/** Resource readiness is separate from persisted asset classification. */
export interface MediaSurfaceSnapshot {
  status: 'detached' | 'loading' | 'ready' | 'failed';
  binding: MediaSurfaceBinding | null;
  error: string | null;
}

/** Ready source data, already resolved through the project asset endpoint. */
export interface VideoPresentationSource {
  canonicalURL: string;
  sourceFingerprint: string;
  presentation: VideoPresentation;
  manifest?: AlphaManifest;
}

/** Notifications from a renderer instance; every callback belongs to one epoch. */
export interface VideoRendererCallbacks {
  ready: (element: HTMLVideoElement, surface: HTMLVideoElement | HTMLCanvasElement) => void;
  frame: (mediaTime: number, seekEpoch: number) => void;
  getSeekEpoch: () => number;
  error: (code: string) => void;
  contextLost: () => void;
  contextRestored: () => void;
}

/** A single renderer's resource cleanup. */
export interface VideoRendererResource {
  dispose: () => void;
}

/** Creates a renderer for a validated ready source in one effect-owned host. */
export type VideoRendererFactory = (
  host: HTMLElement,
  source: VideoPresentationSource,
  callbacks: VideoRendererCallbacks,
) => VideoRendererResource;
