// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AlphaPackedManifest, VideoPresentationVersion } from '@breatic/shared';

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
  original: PresentedSize;
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

/** Ready source data (design §3.3, §7.8): the selected version and, for an alpha-packed one, its verified manifest. */
export interface VideoPresentationSource {
  canonicalURL: string;
  sourceFingerprint: string;
  presentation: VideoPresentationVersion;
  manifest: AlphaPackedManifest | null;
}
/** The size and length a version presents. */
export interface PresentedSize { width: number; height: number; duration: number }

/**
 * The size and length a version presents: its display geometry and duration.
 * @param version - The selected version.
 * @returns Width, height and duration in seconds.
 * @throws {never} Never.
 */
export function presentedSizeOf(version: VideoPresentationVersion): PresentedSize {
  const { width, height, duration } = version.display;
  return { width, height, duration: Number(duration.numerator) / Number(duration.denominator) };
}

/**
 * The runtime source key of a version (design §3.3): canonical URL, source fingerprint and the version shown.
 * @param source - The source.
 * @returns The key.
 * @throws {never} Never.
 */
export function runtimeSourceKeyOf(source: VideoPresentationSource): string {
  return JSON.stringify([source.canonicalURL, source.sourceFingerprint, source.presentation.versionId]);
}

/**
 * The version a runtime source key names, its third part.
 * @param sourceKey - A runtime source key.
 * @returns The versionId, or null for a key of another form.
 * @throws {never} Never.
 */
export function shownVersionOf(sourceKey: string): string | null {
  try {
    const parts: unknown = JSON.parse(sourceKey);
    return Array.isArray(parts) && parts.length === 3 && typeof parts[2] === 'string' ? parts[2] : null;
  } catch {
    return null;
  }
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
