// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The two generation modes the user toggles between: text-to-image and
 * image-to-image. A model belongs to a mode when its `mode` field includes
 * that value (a multi-mode `["i2i", "edit"]` model belongs to `i2i`).
 */
export type ImageGenMode = 't2i' | 'i2i';

/** Default generation sub-mode for a node with none stored (design 2026-07-09 §2.3). */
const DEFAULT_IMAGE_GEN_MODE: ImageGenMode = 't2i';

/**
 * Reads a node's stored generation sub-mode, defaulting + boundary-sanitizing:
 * anything that is not the literal `'i2i'` (undefined, `'t2i'`, or a malformed
 * value from untrusted Yjs) resolves to the default `'t2i'`.
 * @param stored - The node's stored `mode` (free string on the wire).
 * @returns The active {@link ImageGenMode}.
 */
export function resolveMode(stored: string | undefined): ImageGenMode {
  return stored === 'i2i' ? 'i2i' : DEFAULT_IMAGE_GEN_MODE;
}
