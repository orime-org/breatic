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
 * (`completeNodeHandling` / `failNodeHandling`).
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

/**
 * The owner triple a handling opener holds (#1580 #7). Mirrors the data
 * layer's `LeaseToken` — declared structurally here so this pure module
 * keeps zero imports beyond the assets API type.
 */
export interface UploadLease {
  /** Fencing generation from the node's `leaseGen` counter. */
  gen: number;
  /** Yjs clientID of the opening connection. */
  clientId: number;
  /** User who opened the handling. */
  userId: string;
}

/** Injected dependencies for {@link fillNodeFromFile} (upload network + Yjs sinks). */
export interface FillNodeDeps {
  /** Request a presigned upload URL (media path). */
  presign: MediaUploadDeps['presign'];
  /** PUT the file to its presigned URL (media path). */
  putFile: MediaUploadDeps['putFile'];
  /** Read / extract a non-media file's text locally (the text path). */
  extractText: (file: File) => Promise<string>;
  /**
   * Busy gate (#1580 #7, user decision 2026-07-03): true when the node is
   * already handling — a second fill is refused up front instead of
   * silently racing the live lease holder.
   */
  isHandling: (nodeId: string) => boolean;
  /** Called (instead of any work) when the busy gate refuses the fill. */
  onBusy: (nodeId: string) => void;
  /**
   * Open the lease (`handling` + owner triple); `undefined` = node gone.
   * The returned token threads through to the write-backs below.
   */
  setHandling: (nodeId: string) => UploadLease | undefined;
  /**
   * Leased content write-back; returns false when the lease was superseded
   * (the node's final content belongs to the final lease owner).
   */
  setContent: (nodeId: string, content: string, lease: UploadLease) => boolean;
  /** Leased error write-back (fixed-English wire string — never a toast). */
  setError: (nodeId: string, message: string, lease: UploadLease) => boolean;
}

/**
 * Fill an **existing** (empty) node from a picked file — the double-click /
 * Upload-menu path. Unlike {@link runMediaUpload}'s caller in `processFiles`
 * (which CREATES a node), this writes into a node that already exists:
 * refuse if the node is busy (#1580 #7 gate), open the lease, then media
 * files (image / video / audio) presign → PUT and fill the public URL,
 * while every other file is read / extracted locally and fills the text.
 * Failures write a fixed-English error onto the node (shared doc, so never
 * a locale-frozen toast), matching the create-on-drop path's wire strings.
 * Write-backs carry the lease token so a superseded fill cannot clobber a
 * newer owner's work.
 * @param nodeId - The existing node to fill.
 * @param file - The picked file.
 * @param projectId - Owning project (authorizes the presign).
 * @param deps - Injected upload network + content / error sinks.
 */
export async function fillNodeFromFile(
  nodeId: string,
  file: File,
  projectId: string,
  deps: FillNodeDeps,
): Promise<void> {
  if (deps.isHandling(nodeId)) {
    deps.onBusy(nodeId);
    return;
  }
  const lease = deps.setHandling(nodeId);
  if (!lease) return;
  if (fileToNodeSpec(file).needsUpload) {
    await runMediaUpload(file, projectId, {
      presign: deps.presign,
      putFile: deps.putFile,
      onSuccess: (fileUrl) => deps.setContent(nodeId, fileUrl, lease),
      onFailure: () => deps.setError(nodeId, `Upload failed: ${file.name}`, lease),
    });
    return;
  }
  try {
    deps.setContent(nodeId, await deps.extractText(file), lease);
  } catch {
    deps.setError(nodeId, `Extraction failed: ${file.name}`, lease);
  }
}
