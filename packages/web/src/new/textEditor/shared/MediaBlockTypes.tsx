/** Block types shown as file/media in the gutter. */
const MEDIA_LIKE_BLOCK_TYPES = new Set([
  'image',
  'video',
  'audio',
  'pendingImage',
  'pendingVideo',
  'pendingAudio',
  'pendingFile',
]);

/** Hide “Turn into” and use node-level color/align for these block types. */
export function isMediaLikeBlockType(name: string): boolean {
  return MEDIA_LIKE_BLOCK_TYPES.has(name);
}

/**
 * Text align support currently matches the media-like set.
 * Kept as a separate API for semantic clarity in callers.
 */
export function mediaBlockSupportsTextAlign(name: string): boolean {
  return MEDIA_LIKE_BLOCK_TYPES.has(name);
}
