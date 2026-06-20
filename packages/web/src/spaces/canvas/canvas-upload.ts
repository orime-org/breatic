// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { PresignResult } from '@web/data/api/assets';

/**
 * Pure canvas-upload classification + the media upload orchestrator. Classify
 * maps a file's MIME type to the canvas node it becomes; the orchestrator runs
 * presign → PUT and reports success (public URL) or failure through injected
 * callbacks (kept dependency-injected so the async flow is unit-tested without
 * the network or Yjs). Media files (image / audio / video) become a media node
 * whose content is the uploaded URL; every non-media file becomes a text node
 * whose content is read or extracted locally (see `text-extract`), so no file
 * is ever rejected.
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
 * Classify a file by MIME type into the canvas node it becomes. Image / video
 * / audio become their media node (uploaded to storage). EVERYTHING else —
 * text, pdf, docx, xlsx, arbitrary binary — becomes a text node whose content
 * is read or extracted locally (see {@link extractText}); a file with no
 * extractor simply lands as a text node showing an extraction error, so this
 * never rejects a file.
 * @param file - The file (only its `type` MIME string is read).
 * @returns The node spec the file becomes.
 */
export function fileToNodeSpec(file: Pick<File, 'type'>): UploadNodeSpec {
  const mime = file.type;
  if (mime.startsWith('image/')) return { nodeType: 'image', needsUpload: true };
  if (mime.startsWith('video/')) return { nodeType: 'video', needsUpload: true };
  if (mime.startsWith('audio/')) return { nodeType: 'audio', needsUpload: true };
  // Every non-media file → a text node; its content is filled by extractText
  // (text/* read directly; pdf / docx / xlsx parsed; no extractor → error).
  return { nodeType: 'text', needsUpload: false };
}

/** Injected dependencies for {@link runMediaUpload} (network + result sinks). */
export interface MediaUploadDeps {
  /** Request a presigned upload URL (the real one is `assetsApi.presign`). */
  presign: (params: {
    filename: string;
    contentType: string;
    projectId: string;
  }) => Promise<PresignResult>;
  /** PUT the file to its presigned URL (the real one is `assetsApi.putFile`). */
  putFile: (uploadUrl: string, file: File) => Promise<void>;
  /** Called with the public URL once the upload succeeds. */
  onSuccess: (fileUrl: string) => void;
  /** Called (no args) when presign or the PUT fails. */
  onFailure: () => void;
}

/**
 * Upload a media file: presign → PUT the bytes → report the public URL on
 * success, or signal failure. Never throws — both outcomes route through the
 * `onSuccess` / `onFailure` callbacks so the caller can write them to Yjs
 * (`setNodeContent` / `setNodeError`).
 * @param file - The media file to upload.
 * @param projectId - Owning project (authorizes the presign).
 * @param deps - Injected presign / putFile / result callbacks.
 */
export async function runMediaUpload(
  file: File,
  projectId: string,
  deps: MediaUploadDeps,
): Promise<void> {
  try {
    const { uploadUrl, fileUrl } = await deps.presign({
      filename: file.name,
      contentType: file.type,
      projectId,
    });
    await deps.putFile(uploadUrl, file);
    deps.onSuccess(fileUrl);
  } catch {
    deps.onFailure();
  }
}
