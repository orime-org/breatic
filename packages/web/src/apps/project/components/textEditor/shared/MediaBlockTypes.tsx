/** Block types shown as file/media in the gutter — hide “Turn into” and use node-level color/align. */
export function isMediaLikeBlockType(name: string): boolean {
  return (
    name === 'image' ||
    name === 'video' ||
    name === 'audio' ||
    name === 'pendingImage' ||
    name === 'pendingVideo' ||
    name === 'pendingAudio' ||
    name === 'pendingFile'
  );
}

export function mediaBlockSupportsTextAlign(name: string): boolean {
  return (
    name === 'image' ||
    name === 'video' ||
    name === 'audio' ||
    name === 'pendingImage' ||
    name === 'pendingVideo' ||
    name === 'pendingAudio' ||
    name === 'pendingFile'
  );
}
