// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The blocks that show a picture, a video or a sound (inner#1127), named once
 * for every place in the body that treats them apart from text.
 */

/** The media block types. */
export const MEDIA_BLOCK_TYPES = ['image', 'video', 'audio'] as const;

/** One media block type. */
export type MediaBlockType = (typeof MEDIA_BLOCK_TYPES)[number];

const MEDIA = new Set<string>(MEDIA_BLOCK_TYPES);

/**
 * Whether a block type is one of the media blocks.
 * @param name - The block's type name.
 * @returns True for an image, a video or an audio.
 */
export function isMediaBlockType(name: string): name is MediaBlockType {
  return MEDIA.has(name);
}
