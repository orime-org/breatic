// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Focus-crop orchestration (#1782): a confirmed marquee becomes a
 * standalone uploaded asset appended to the panel node's `focusImages`.
 *
 * Pipeline: export the crop (offscreen canvas, natural pixels) → wrap the
 * blob as a PNG File named from the source-node snapshot → run it through
 * the standard media-upload pipeline (hash → presign dedup → PUT with
 * retries) → append the {@link FocusImage} copy to Yjs. Nothing is
 * written on any failure path — the pending rail entry is the caller's
 * local state and simply disappears.
 */

import type { FocusImage } from '@breatic/shared';

import type { CropRect } from '@web/spaces/canvas/focus/crop-math';

/** Everything {@link runFocusCrop} needs injected (all unit-mockable). */
export interface FocusCropDeps {
  /** Export the natural-pixel crop of the source image as a PNG blob. */
  exportCrop: (sourceUrl: string, crop: CropRect) => Promise<Blob>;
  /**
   * Upload the file and resolve the public URL (throws on failure) —
   * production binds the standard `runMediaUpload` pipeline.
   */
  uploadFile: (file: File, projectId: string) => Promise<string>;
  /** Append the finished copy to the panel node's focusImages (Yjs). */
  addFocusImage: (image: FocusImage) => void;
  /** Failure sink, discriminated by stage (for the toast wording). */
  onFailure: (stage: 'export' | 'upload') => void;
  /** Id factory (uuid v4 in production; fixed in tests). */
  makeId: () => string;
}

/** What one confirmed marquee carries into the pipeline. */
export interface FocusCropParams {
  /** The source node's image URL (the content being cropped). */
  sourceUrl: string;
  /** The source node's display name, snapshotted at crop time. */
  sourceName: string;
  /** The confirmed crop in natural (source-resolution) pixels. */
  crop: CropRect;
  /** Owning project (authorizes the presign). */
  projectId: string;
}

/**
 * Build the upload filename for a crop: `focus-<source snapshot>.png`,
 * sanitized to the presign filename rules (no path separators / control
 * chars; ≤255 chars) with a `crop` fallback when nothing survives.
 * @param sourceName - The source node's display name.
 * @returns A presign-safe .png filename.
 */
export function focusCropFilename(sourceName: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars IS the intent (mirrors the presign whitelist)
  const cleaned = sourceName.replace(/[/\\\x00-\x1f\x7f]/g, '').slice(0, 200);
  return `focus-${cleaned.length > 0 ? cleaned : 'crop'}.png`;
}

/**
 * Run one confirmed focus crop end to end. Never throws — both failure
 * stages route through `deps.onFailure` so the caller clears its pending
 * entry and toasts; nothing reaches Yjs unless the upload succeeded.
 * @param params - The confirmed crop (source URL / name, natural rect, project).
 * @param deps - Injected export / upload / write / failure sinks.
 */
export async function runFocusCrop(
  params: FocusCropParams,
  deps: FocusCropDeps,
): Promise<void> {
  let blob: Blob;
  try {
    blob = await deps.exportCrop(params.sourceUrl, params.crop);
  } catch {
    deps.onFailure('export');
    return;
  }
  try {
    const file = new File([blob], focusCropFilename(params.sourceName), {
      type: 'image/png',
    });
    const url = await deps.uploadFile(file, params.projectId);
    deps.addFocusImage({
      id: deps.makeId(),
      url,
      name: params.sourceName,
      width: params.crop.width,
      height: params.crop.height,
    });
  } catch {
    deps.onFailure('upload');
  }
}
