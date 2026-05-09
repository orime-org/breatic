/**
 * `useUploadFiles` — single canonical hook for "user picks N files,
 * upload to permanent storage, get back the URLs the canvas can write
 * to Yjs".
 *
 * Flow per file (mirrors `data/storage/upload-blob.ts`, broadcasts
 * meta extraction to consumers):
 *
 *   1. `presign({ filename, content_type, project_id })` → `{ uploadUrl, fileUrl, kind }`
 *   2. PUT the file to `uploadUrl` (direct to S3/OSS/local)
 *   3. Decode media meta in parallel — image/video → width/height,
 *      video/audio → duration. Decoding runs locally; the server
 *      doesn't infer dimensions, so the canvas needs them now to
 *      lay the new node out without a flicker.
 *
 * The hook is intentionally thin — caller decides what node to
 * create from the result. F5-framework (this PR) wires it from
 * `LeftFloatingMenu`'s upload button + `ClipboardPasteHandler` +
 * `AudioNode`'s record-end handler, which together cover every
 * upload entry point post-F5.
 *
 * @example
 * ```tsx
 * const { upload, uploading } = useUploadFiles();
 * const onPick = async (files: File[]) => {
 *   const results = await upload(files, { projectId });
 *   for (const r of results) {
 *     createDataNode({
 *       type: NODE_TYPE_BY_KIND[r.kind],
 *       data: { content: r.fileUrl, width: r.width, height: r.height, duration: r.duration },
 *     });
 *   }
 * };
 * ```
 */
import { useCallback, useState } from 'react';
import { presign, uploadToPresignedUrl } from '@/data/api/assets';
import {
  getAudioMeta,
  getImageMeta,
  getVideoMeta,
} from '@/utils/mediaUtils';
import type { PresignResult } from '@/data/api/assets';

/** Decoded local meta — keys vary by modality so `?` everywhere. */
export interface UploadedFileMeta {
  width?: number;
  height?: number;
  duration?: number;
}

/** Per-file upload result the canvas turns into a `createDataNode` call. */
export interface UploadedFile extends UploadedFileMeta {
  /** Original `File` object — handy when the caller wants to keep the filename. */
  file: File;
  /** Permanent URL to write to `data.content`. */
  fileUrl: string;
  /** Server-classified kind — drives node-type pick at the call site. */
  kind: PresignResult['kind'];
}

/** ReactFlow node types per upload kind, keyed off the server's `kind` classifier. */
export const NODE_TYPE_BY_KIND: Record<PresignResult['kind'], string | null> = {
  image: '1002',
  video: '1003',
  audio: '1004',
  // Document / file uploads don't have an asset node yet — callers
  // currently surface a "unsupported file kind" toast. Lands when the
  // doc-asset node story matures.
  document: null,
  file: null,
};

interface UseUploadFilesResult {
  /**
   * Upload every file and resolve only after every PUT is done.
   * Order of the result matches `files` order. Errors bubble — the
   * caller wraps in try/catch to surface a toast.
   */
  upload: (files: File[], opts: { projectId: string }) => Promise<UploadedFile[]>;
  /** Truthy while at least one upload is in flight. */
  uploading: boolean;
}

/**
 * React hook over {@link uploadOne} that tracks an `uploading` flag
 * for the `<button disabled>` UX. The flag is reference-stable across
 * renders; safe to use in `disabled={uploading}` directly.
 */
export function useUploadFiles(): UseUploadFilesResult {
  const [uploading, setUploading] = useState(false);

  const upload = useCallback(
    async (files: File[], opts: { projectId: string }): Promise<UploadedFile[]> => {
      if (files.length === 0) return [];
      setUploading(true);
      try {
        return await Promise.all(files.map((f) => uploadOne(f, opts)));
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  return { upload, uploading };
}

/**
 * Upload one file and decode meta in parallel with the PUT.
 *
 * Exported for unit tests + non-React callers (e.g. the AudioNode
 * recording flow that doesn't have a React-tree-stable hook context
 * because record-end fires from a wavesurfer event listener).
 */
export async function uploadOne(
  file: File,
  opts: { projectId: string },
): Promise<UploadedFile> {
  const presignRes = await presign({
    filename: file.name,
    content_type: file.type || 'application/octet-stream',
    project_id: opts.projectId,
  });
  const data = presignRes.data;
  if (!data) throw new Error('presign returned empty payload');

  // PUT + meta decode race side-by-side — meta decode reads the
  // local File; the PUT reads the same File but the browser stream
  // doesn't lock it. Saves ~100-300ms on big uploads.
  const [, meta] = await Promise.all([
    uploadToPresignedUrl(data.uploadUrl, file),
    extractMeta(file),
  ]);

  return {
    file,
    fileUrl: data.fileUrl,
    kind: data.kind,
    ...meta,
  };
}

/** Modality-aware meta extraction. Returns `{}` for kinds without a decoder. */
async function extractMeta(file: File): Promise<UploadedFileMeta> {
  const t = file.type;
  if (t.startsWith('image/')) return getImageMeta(file);
  if (t.startsWith('video/')) return getVideoMeta(file);
  if (t.startsWith('audio/')) return getAudioMeta(file);
  return {};
}
