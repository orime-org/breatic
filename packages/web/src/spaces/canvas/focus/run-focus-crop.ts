// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import type { CropSource } from '@web/spaces/canvas/focus/crop-export';

/** Everything `runFocusCrop` needs injected (all unit-mockable). */
export interface FocusCropDeps {
  /** Export the natural-pixel crop of the source as a PNG blob. */
  exportCrop: (source: CropSource, crop: CropRect) => Promise<Blob>;
  /**
   * Upload the file and resolve the public URL (throws on failure) —
   * production binds the standard `runMediaUpload` pipeline.
   */
  uploadFile: (file: File, projectId: string) => Promise<string>;
  /** Append the finished copy to the panel node's focusImages (Yjs). */
  addFocusImage: (image: FocusImage) => void;
  /**
   * Failure sink, discriminated by stage (for the toast wording). Two of these
   * are not retryable and must not share the retryable wording: `hash` means
   * the browser could not fingerprint the crop, whose remedy is a reload, and
   * `storage` means the account is out of room, whose remedy is the admin's to
   * apply. The upload pipeline already tells these apart, so this carries its
   * verdict out rather than folding everything but `hash` into `upload`.
   */
  onFailure: (stage: 'export' | 'upload' | 'hash' | 'storage') => void;
  /** Id factory (uuid v4 in production; fixed in tests). */
  makeId: () => string;
}

/** What one confirmed marquee carries into the pipeline. */
export interface FocusCropParams {
  /** The source node's asset URL (the content being cropped). */
  sourceUrl: string;
  /** The source node's display name, snapshotted at crop time. */
  sourceName: string;
  /**
   * For a video source, the frame the user parked on, in seconds; `null` for
   * a still image. Required rather than optional so the object literals that
   * build these params cannot omit it. The `exportCrop` assignment is outside
   * that reach: parameter contravariance accepts an implementation that never
   * reads this field, which is what the end-to-end test in
   * `focus/__tests__/crop-export.test.ts` holds down.
   */
  sourceTimeSeconds: number | null;
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
    blob = await deps.exportCrop(
      { url: params.sourceUrl, timeSeconds: params.sourceTimeSeconds },
      params.crop,
    );
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
  } catch (err) {
    // The upload pipeline tags every refusal it can tell apart, so the caller
    // can offer the right remedy. Anything it did not tag is transient.
    const tagged = err instanceof Error ? err.message : '';
    deps.onFailure(
      tagged === 'hash' || tagged === 'storage' ? tagged : 'upload',
    );
  }
}
