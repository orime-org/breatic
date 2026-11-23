// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Focus-crop orchestration (#1782, #1580): a confirmed marquee becomes a
 * standalone uploaded asset in the panel node's `focusImages`.
 *
 * Pipeline: export the crop (offscreen canvas, natural pixels) → wrap the
 * blob as a PNG File named from the source-node snapshot → run it through
 * the standard media-upload pipeline (hash → ticket dedup → parts to the
 * ingest Worker), the ticket naming the image the crop becomes. Once the
 * bytes are registered, collab adds that image to the node's pool; the page
 * writes nothing. The pending rail entry, under the same id, is the caller's
 * local state: it goes when the image lands, or through `onFailure`.
 */

import {
  isUploadFailureReason,
  type UploadFailureReason,
} from '@web/data/upload/media-upload';
import type { CropRect } from '@web/lib/crop-math';
import type { CropSource } from '@web/spaces/canvas/focus/crop-export';
import { uploadFailureMessageKey } from '@web/spaces/canvas/upload-failure';

/** Everything `runFocusCrop` needs injected (all unit-mockable). */
export interface FocusCropDeps {
  /** Export the natural-pixel crop of the source as a PNG blob. */
  exportCrop: (source: CropSource, crop: CropRect) => Promise<Blob>;
  /**
   * Upload the file as the named focus image, resolving once the upload ended
   * well (throws on failure) — production binds the standard media upload
   * with the panel node's Space and node. `onSent` is called once the bytes are
   * sent and only the server's registration is left.
   */
  uploadFile: (file: File, projectId: string, focusImage: FocusCropImage, onSent: () => void) => Promise<unknown>;
  /**
   * Failure sink, discriminated by stage (for the toast wording). Two of these
   * are not retryable and must not share the retryable wording: `hash` means
   * the browser could not fingerprint the crop, whose remedy is a reload, and
   * `storage` means the account is out of room, whose remedy is the admin's to
   * apply. The upload pipeline already tells these apart, so this carries its
   * verdict out rather than folding everything but `hash` into `upload`.
   */
  onFailure: (stage: 'export' | UploadFailureReason) => void;
}

/** The image a crop becomes, as its upload names it; its address comes from the registered asset. */
export interface FocusCropImage {
  id: string;
  name: string;
  width: number;
  height: number;
}

/** What one confirmed marquee carries into the pipeline. */
export interface FocusCropParams {
  /** The crop's id: its pending entry's, and the image's once it lands. */
  id: string;
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
  /** Owning project (authorizes the ticket). */
  projectId: string;
}

/**
 * Build the upload filename for a crop: `focus-<source snapshot>.png`,
 * sanitized to the filename rules the ticket endpoint enforces (no path
 * separators / control chars; ≤255 chars) with a `crop` fallback when nothing
 * survives.
 * @param sourceName - The source node's display name.
 * @returns A filename the ticket endpoint accepts.
 */
export function focusCropFilename(sourceName: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars IS the intent (mirrors the ticket endpoint's whitelist)
  const cleaned = sourceName.replace(/[/\\\x00-\x1f\x7f]/g, '').slice(0, 200);
  return `focus-${cleaned.length > 0 ? cleaned : 'crop'}.png`;
}

/**
 * Run one confirmed focus crop. The returned promise settles once the browser's
 * half is over: the bytes are sent, a dedup hit answered, or it failed. Collab
 * adds the image, so the page may leave from then on (the Space's leave guard
 * waits on this). The wait for the upload's ending goes on and reports a
 * failure through `deps.onFailure`. Never throws.
 * @param params - The confirmed crop (id, source URL / name, natural rect, project).
 * @param deps - Injected export / upload / failure sinks.
 * @returns Once the browser's half is over.
 */
export function runFocusCrop(
  params: FocusCropParams,
  deps: FocusCropDeps,
): Promise<void> {
  return new Promise((sent) => {
    void (async (): Promise<void> => {
      let blob: Blob;
      try {
        blob = await deps.exportCrop(
          { url: params.sourceUrl, timeSeconds: params.sourceTimeSeconds },
          params.crop,
        );
      } catch {
        deps.onFailure('export');
        sent();
        return;
      }
      try {
        const file = new File([blob], focusCropFilename(params.sourceName), {
          type: 'image/png',
        });
        await deps.uploadFile(file, params.projectId, {
          id: params.id,
          name: params.sourceName,
          width: params.crop.width,
          height: params.crop.height,
        }, () => sent());
      } catch (err) {
        // The upload pipeline tags every refusal it can tell apart, so the caller
        // can offer the right remedy. Anything it did not tag is transient.
        const tagged = err instanceof Error ? err.message : '';
        deps.onFailure(isUploadFailureReason(tagged) ? tagged : 'upload');
      }
      sent();
    })();
  });
}

/**
 * The sentence a failed focus crop shows.
 *
 * A reason that names its cause reads as the canvas's upload sentence for it;
 * the catch-all and a transfer read as the crop's own.
 * @param stage - Where it failed: the export, or why the upload ended.
 * @returns The message key.
 */
export function focusFailureMessageKey(stage: 'export' | UploadFailureReason): string {
  if (stage === 'export') return 'canvas.generatePanel.focusExportFailed';
  if (stage === 'upload' || stage === 'transfer') return 'canvas.generatePanel.focusUploadFailed';
  return uploadFailureMessageKey(stage);
}
