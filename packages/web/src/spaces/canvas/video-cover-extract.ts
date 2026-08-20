// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Browser-side first-frame cover extraction for uploaded videos (#1816).
 *
 * A video the user uploads carries no cover, so the VideoNode poster + the
 * reference rail / @ chip have nothing to show and generated-vs-uploaded video
 * diverge on the same `coverUrl` field. This grabs the first frame off a local
 * `<video>` (objectURL → seek to frame 0 → `<canvas>` → PNG blob), mirroring
 * the worker's Sharp cover so both paths feed one `coverUrl`. PNG is the format
 * convention for our-own-produced images (#1826 §8) and is the one type the
 * `toBlob` spec requires every user agent to support, so — unlike WebP — the
 * encoded format never diverges by browser.
 *
 * The type this module declares is not a hint the backend later corrects: on
 * S3 / OSS it is signed into the presigned PUT (`getUploadUrl`), stored as the
 * object's Content-Type, and read straight back by `head()` into the asset
 * ledger row. Only the local adapter sniffs the bytes. That is why the
 * declaration lives here rather than at each call site.
 *
 * Best-effort by contract: a codec the browser cannot decode (HEVC etc.), a
 * zero-sized frame, or a timeout resolves to `null` — NEVER throws. The caller
 * (the pre-flight gate) turns `null` into a friendly reject at file-pick, so an
 * undecodable video never becomes a half-uploaded node. The actual raster is
 * covered by the real-browser smoke (jsdom has no video decode / canvas
 * raster, same as `focus/crop-export.ts`); the unit tests drive the event /
 * timeout / cleanup control flow with a mocked `<video>` / `<canvas>`.
 */

/** Options for {@link extractVideoFirstFrame}. */
export interface ExtractVideoFirstFrameOptions {
  /** Abort + resolve `null` after this many ms (decode hang guard). */
  timeoutMs?: number;
}

/**
 * The cover's format for the whole browser side: both the canvas encoder and
 * the File handed to the upload read it from here, so the encoded bytes and the
 * declared type cannot drift apart. The filename carries the matching
 * {@link COVER_EXTENSION}. Nothing mechanically stops a new call site from
 * building a cover File by hand; what keeps that from happening is that
 * {@link videoCoverFile} is the only exported way to get one.
 */
const COVER_MIME_TYPE = 'image/png';

/**
 * File extension matching {@link COVER_MIME_TYPE}. Kept in step by the unit
 * tests, which assert the resulting name and type together.
 */
const COVER_EXTENSION = '.png';

/** Default decode-hang guard: a real first-frame decode is well under this. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * A hair past 0, still inside frame 0 for any real frame rate (< any frame's
 * duration): seeking to the CURRENT position (0 at load) may not fire `seeked`
 * in every browser, so nudging by this guarantees the event AND a paintable
 * decode while staying on the first frame.
 *
 * Exported because the focus crop export (#1987) faces the same seek: a
 * freshly built element sits at 0 and the frame the user wants is often 0
 * too. One definition, so the two cannot drift to different offsets.
 */
export const FIRST_FRAME_SEEK_S = 0.0001;

/**
 * Extract the first frame of a local video File as a PNG cover blob, or
 * `null` when the browser cannot decode it (unsupported codec), the frame is
 * empty, or the decode times out. Never throws.
 *
 * Extraction runs off the LOCAL File (`URL.createObjectURL`) — the browser
 * already holds the bytes, so it is instant, needs no CORS, and can run before
 * the upload even starts (the pre-flight gate). The object URL is always
 * revoked (success or failure).
 * @param file - The video File to grab the first frame from.
 * @param opts - Optional decode-timeout override.
 * @returns The first-frame PNG blob, or `null` on any failure / timeout.
 */
export async function extractVideoFirstFrame(
  file: File,
  opts?: ExtractVideoFirstFrameOptions,
): Promise<Blob | null> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  try {
    return await new Promise<Blob | null>((resolve) => {
      let settled = false;
      /**
       * Resolve exactly once and stop the timeout — every terminal path
       * (drawn blob, decode error, empty frame, timeout) funnels through here.
       * @param blob - The cover blob, or `null` on any failure.
       */
      const finish = (blob: Blob | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(blob);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);

      video.muted = true;
      video.preload = 'auto';
      // playsInline avoids iOS trying to fullscreen the offscreen element.
      video.playsInline = true;
      video.onerror = (): void => finish(null);
      video.onloadeddata = (): void => {
        // The first frame is loaded; nudge a seek to force a paintable decode
        // and guarantee `seeked` fires (a no-op seek to the current position
        // may not). FIRST_FRAME_SEEK_S stays inside frame 0.
        try {
          video.currentTime = FIRST_FRAME_SEEK_S;
        } catch {
          finish(null);
        }
      };
      video.onseeked = (): void => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          // Keep the alpha channel. Opting out (`{ alpha: false }`) makes the
          // PNG smaller, but video frames are NOT always opaque: WebM carries a
          // VP8/VP9 alpha plane, and compositing such a frame onto an opaque
          // context turns every transparent pixel into solid black — a wrong
          // cover, not a smaller one. Verified in Chromium against a VP9 file
          // with a transparent half: those pixels read [0,0,0,0] with alpha on
          // and [0,0,0,255] with it off.
          const ctx = canvas.getContext('2d');
          if (ctx === null || canvas.width === 0 || canvas.height === 0) {
            finish(null);
            return;
          }
          ctx.drawImage(video, 0, 0);
          // PNG is lossless — `toBlob`'s quality argument does not apply.
          canvas.toBlob((blob) => finish(blob), COVER_MIME_TYPE);
        } catch {
          finish(null);
        }
      };
      video.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
    // Drop the decoder's hold on the (now revoked) URL.
    video.removeAttribute('src');
  }
}

/**
 * Derive the cover File name from a video File name: `<base>-cover.png`.
 *
 * Module-private on purpose: {@link videoCoverFile} is the only exported way to
 * build a cover, so a caller cannot assemble one out of a name and a hand-picked
 * type. The name itself is what the presign contract carries — the backend takes
 * the stored key's extension from it — and it keeps the cover readable next to
 * its video when someone browses storage.
 * @param videoFileName - The source video's File name.
 * @returns The cover's `.png` filename.
 */
function videoCoverFileName(videoFileName: string): string {
  const dot = videoFileName.lastIndexOf('.');
  const base = dot > 0 ? videoFileName.slice(0, dot) : videoFileName;
  return `${base}-cover${COVER_EXTENSION}`;
}

/**
 * Wrap an extracted cover blob into the File the upload pipeline expects.
 *
 * Both upload entry points (drop-on-canvas and fill-an-empty-node) call this, so
 * the declared type and the filename come from the same place as the bytes
 * {@link extractVideoFirstFrame} encodes, and neither can be changed for one
 * entry point without the other.
 *
 * The declared type matters beyond the presign call: on S3 / OSS it is signed
 * into the upload URL and becomes the stored object's Content-Type, which the
 * ledger then records as the asset's `mimeType` and feeds to `detectKind` (the
 * local adapter instead sniffs the bytes). A call site that guessed wrong would
 * mislabel the asset, not just the request.
 * @param coverBlob - The first-frame blob from {@link extractVideoFirstFrame}.
 * @param videoFileName - The source video's File name (drives the cover name).
 * @returns The cover File, ready to presign and PUT.
 */
export function videoCoverFile(coverBlob: Blob, videoFileName: string): File {
  return new File([coverBlob], videoCoverFileName(videoFileName), {
    type: COVER_MIME_TYPE,
  });
}
