// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';

/** Owned pixel rectangle, independent of renderer configuration. */
export interface VideoPresentationRect { x: number; y: number; width: number; height: number }
/** Owned canonical classification and presentation readiness. */
export interface VideoPresentation {
  schemaVersion: 1;
  sourceFingerprint: string;
  original: { width: number; height: number; duration: number };
  state: 'classifying' | 'native' | 'alpha_pending' | 'alpha_ready' | 'failed';
  alpha?: { manifestURL: string };
  attempt?: { jobId: string; deadlineAt: number };
  error?: string;
}
/** Geometry and URL of one verified packed-alpha derivative. */
export interface AlphaManifest {
  schemaVersion: 1;
  sourceFingerprint: string;
  packedURL: string;
  packedWidth: number;
  packedHeight: number;
  colorRect: VideoPresentationRect;
  alphaRect: VideoPresentationRect;
}

export const videoPresentationSchema: z.ZodType<VideoPresentation> = z.custom<VideoPresentation>();
export const alphaManifestSchema: z.ZodType<AlphaManifest> = z.custom<AlphaManifest>();

/**
 * Derives a descriptor key from its registered canonical key.
 * @param _key - Registered canonical storage key.
 * @returns Deterministic versioned descriptor key.
 * @throws {never} Never.
 */
export function videoPresentationKeyFor(_key: string): string { return ''; }
/**
 * Derives a packed derivative key from its registered canonical key.
 * @param _key - Registered canonical storage key.
 * @returns Deterministic versioned packed key.
 * @throws {never} Never.
 */
export function alphaPackedKeyFor(_key: string): string { return ''; }
/**
 * Derives an alpha manifest key from its registered canonical key.
 * @param _key - Registered canonical storage key.
 * @returns Deterministic versioned alpha manifest key.
 * @throws {never} Never.
 */
export function alphaManifestKeyFor(_key: string): string { return ''; }
/**
 * Reads a descriptor only when its shape and canonical fingerprint match.
 * @param _value - Untrusted descriptor JSON.
 * @param _sourceFingerprint - Registered canonical SHA256.
 * @returns A valid current descriptor, or null for unknown.
 * @throws {never} Malformed or obsolete JSON resolves to unknown.
 */
export function parseVideoPresentation(_value: unknown, _sourceFingerprint: string): VideoPresentation | null { return null; }
/**
 * Checks whether a valid manifest presents this descriptor's canonical source.
 * @param _manifest - Parsed alpha manifest.
 * @param _presentation - Parsed canonical descriptor.
 * @returns Whether both source and original display geometry match.
 * @throws {never} Never.
 */
export function alphaManifestMatchesPresentation(_manifest: AlphaManifest, _presentation: VideoPresentation): boolean { return false; }
