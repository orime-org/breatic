// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure canvas-upload classification — maps a file's MIME type to the canvas
 * node it becomes and whether that needs a storage upload. Media files
 * (image / audio / video) become a media node whose content is the uploaded
 * URL; text files become a text node whose content is read locally (no
 * upload); anything else has no canvas node form and is rejected.
 */

/** How an uploaded file maps onto the canvas. */
export interface UploadNodeSpec {
  /** The canvas node form the file becomes. */
  nodeType: 'image' | 'video' | 'audio' | 'text';
  /**
   * Whether the file's bytes go to storage (media → `true`, content = URL) or
   * are read inline (text → `false`, content = the text itself).
   */
  needsUpload: boolean;
}

/**
 * Classify a file by MIME type into the canvas node it becomes, or `null`
 * when the canvas has no node form for it (pdf / arbitrary binary).
 * @param file - The file (only its `type` MIME string is read).
 * @returns The node spec, or `null` for an unsupported type.
 */
export function fileToNodeSpec(file: Pick<File, 'type'>): UploadNodeSpec | null {
  const mime = file.type;
  if (mime.startsWith('image/')) return { nodeType: 'image', needsUpload: true };
  if (mime.startsWith('video/')) return { nodeType: 'video', needsUpload: true };
  if (mime.startsWith('audio/')) return { nodeType: 'audio', needsUpload: true };
  if (mime.startsWith('text/')) return { nodeType: 'text', needsUpload: false };
  return null;
}
