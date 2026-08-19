// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { isDedupHit, type PresignResponse } from '@web/data/api/assets';
import { validFocusImages } from '@web/data/focus-images';
import {
  retryTransient,
  type UploadClientConfig,
} from '@web/data/upload/upload-retry';
import {
  VIDEO_SLOTS,
  readSlotPick,
} from '@web/spaces/canvas/generate/video-slots';
import type { VideoSlotSpec } from '@web/spaces/canvas/generate/video-slots';
import { videoCoverFile } from '@web/spaces/canvas/video-cover-extract';

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
 * is read or extracted locally (see `extractText`); a file with no
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

/** Why the canvas refused a picked file — the caller maps it to a message. */
export type FileRejection = 'empty' | 'tooLarge';

/**
 * Decide whether a picked file may become a node, BEFORE anything is created
 * or sent. Both selection paths (the batch drop / picker and the single-node
 * fill) run this, so one rule covers every way a file enters the canvas.
 *
 * Two refusals:
 *   - `empty` — a 0-byte file, whatever its type. It would make an empty node:
 *     nothing to show, nothing to dedup against, and a storage row for no
 *     bytes. Refused for EVERY file, not just uploads, because an empty text
 *     node is just as pointless as an empty image (user decision 2026-07-26).
 *     Needs no config, so it holds even when the cap is unknown.
 *   - `tooLarge` — only for files that actually upload; the server's 413 is
 *     the authoritative gate, this just saves the round trip. Text files never
 *     upload (read locally), so the cap does not apply to them.
 * @param file - The picked file (only `type` + `size` are read).
 * @param maxBytes - The upload cap, or `Infinity` when the config fetch failed.
 * @returns The reason to refuse, or null to admit.
 */
export function checkFileAdmission(
  file: Pick<File, 'type' | 'size'>,
  maxBytes: number,
): FileRejection | null {
  if (file.size === 0) return 'empty';
  if (fileToNodeSpec(file).needsUpload && file.size > maxBytes) {
    return 'tooLarge';
  }
  return null;
}

/**
 * The storage identity a finished upload reports to the activity-feed
 * handshake (#1609): regular path carries the stored key; a dedup hit
 * carries `dedup: true` (nothing was uploaded).
 */
export interface UploadedInfo {
  kind: string;
  fileUrl: string;
  /**
   * Content sha256 — ALWAYS present. An upload whose hash could not be
   * computed is refused before presigning (#1826 §0 rule 4), so no upload can
   * reach this point without one. It was `string | null` while a hashless
   * upload could still proceed; keeping that shape would let a caller omit
   * `hash` from the report, which the server answers with a 400 (malformed
   * request) instead of the fail-closed 422 the policy intends.
   */
  hash: string;
  /** Stored object key (regular path only). */
  key?: string;
  /** True when the presign answered `alreadyExists` (B.2 instant dedup). */
  dedup?: true;
}

/**
 * What the `/uploaded` report returns to the caller: the REGISTERED row's
 * canonical URL(s). The node pins THESE — never the presign-minted temp key
 * (§0 rule 2 / §4.1 step 7): a concurrent-dedup loser's temp key is an orphan
 * that the offline GC reclaims → 404. `coverUrl` is present only for a video
 * whose cover resolved server-side.
 */
export interface UploadReportResult {
  fileUrl: string;
  coverUrl?: string;
}

/**
 * Why an upload ended in `onFailure` — the caller picks the message from this.
 * `hash` means the browser could not fingerprint the file (worker/WASM/read
 * failure), which no retry of the SAME page fixes: the fix is a reload.
 * `storage` means the studio's account is out of room (#89), which no retry
 * fixes either — but for the opposite reason: nothing is broken, there is
 * simply nowhere to put the bytes until the admin acts.
 * `upload` is everything else (config / presign / PUT / report), which a retry
 * can fix.
 */
export type UploadFailureReason = 'hash' | 'storage' | 'upload';

/**
 * Carries an {@link UploadFailureReason} across the Promise boundary of the
 * video/cover sub-uploads, so the atomic orchestrator can report WHY it failed
 * instead of flattening every cause into "upload failed".
 */
class MediaUploadError extends Error {
  /**
   * Build a sub-upload rejection that remembers its cause.
   * @param reason - Which failure class ended the sub-upload.
   */
  constructor(readonly reason: UploadFailureReason) {
    super(`media upload failed: ${reason}`);
    this.name = 'MediaUploadError';
  }
}

/**
 * Recover the failure reason from a rejected sub-upload, defaulting to
 * `upload` for anything that is not a {@link MediaUploadError} (an unexpected
 * throw is a transient failure as far as the user is concerned).
 * @param err - The rejection value.
 * @returns The failure reason to report.
 */
function failureReasonOf(err: unknown): UploadFailureReason {
  if (err instanceof MediaUploadError) return err.reason;
  return isStorageFull(err) ? 'storage' : 'upload';
}

/**
 * Whether a rejection is the server saying the account is out of storage.
 *
 * Read off the status rather than the message: the sentence is localized on
 * the server side and matching on it would break the moment anyone edits the
 * copy or a user switches language.
 * @param err - The rejection value.
 * @returns True for a 507 answer.
 */
function isStorageFull(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { status?: unknown }).status === 507
  );
}

/** Injected dependencies for {@link runMediaUpload} (network + result sinks). */
export interface MediaUploadDeps {
  /** Fetch the session-cached upload knobs (`assetsApi.fetchUploadConfig`). */
  getUploadConfig: () => Promise<UploadClientConfig>;
  /**
   * Fingerprint the file (`hashFile`). `null` = the browser could not hash it;
   * the upload is then REFUSED up front (user decision 2026-07-26) — see
   * {@link runMediaUpload}.
   */
  hashFile: (file: File) => Promise<string | null>;
  /** Request a presigned upload URL or a dedup hit (`assetsApi.presign`). */
  presign: (params: {
    filename: string;
    contentType: string;
    projectId: string;
    size: number;
    /** Mandatory — a hashless upload is refused before it reaches here. */
    hash: string;
  }) => Promise<PresignResponse>;
  /** PUT the file with retries + stall guard (`putFileWithRetry`). */
  putFile: (
    uploadUrl: string,
    file: File,
    cfg: UploadClientConfig,
  ) => Promise<void>;
  /**
   * Called with the REGISTERED canonical URL once the report confirms it —
   * this is what the node pins + exits handling on (§4.1 step 7). Never called
   * with a presign temp key.
   */
  onSuccess: (fileUrl: string) => void;
  /**
   * Called when the upload cannot complete. `reason` tells the caller which
   * message to show: `hash` (we could not fingerprint the file — reload) vs
   * `upload` (config / presign / PUT / report failed — retry).
   */
  onFailure: (reason: UploadFailureReason) => void;
  /**
   * Reports the upload to the `/uploaded` handshake and RETURNS the registered
   * row's canonical URL — the node pins that (§0 rule 2), not the presign temp
   * key. The orchestrator AWAITS this before `onSuccess`; a rejection (e.g. a
   * node-bound register 422) propagates → `onFailure` (Retry). The reporting
   * caller (fillNodeFromFile) returns the canonical; a NON-reporting caller
   * (the `uploadOneMedia` sub-upload, which defers its report) returns
   * `undefined`, so `onSuccess` falls back to the presign URL.
   */
  onUploaded?: (info: UploadedInfo) => Promise<UploadReportResult> | undefined;
  /** Backoff sleep override (tests only — production uses real timers). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Upload a media file (#1609 orchestration): fetch the knobs → hash the
 * bytes (Web Worker, any size) → presign with size + hash — a dedup hit
 * skips the upload entirely and reuses the existing URL (B.2) — else PUT
 * with retries, then report the public URL. The two halves retry under
 * different rules: presign through `retryTransient` on the knobs above, the
 * PUT inside the shared HTTP transport on its own compiled-in policy. Never throws — both
 * outcomes route through `onSuccess` / `onFailure` so the caller can
 * write them to Yjs (`completeNodeHandling` / `failNodeHandling`).
 *
 * NO HASH, NO UPLOAD (user decision 2026-07-26). The content hash is the
 * storage design's ticket — instant dedup, within-studio dedup and the ledger
 * row all key on it, and `studio_assets.content_hash` is NOT NULL — so a
 * hashless upload could never be registered and would pin the node to an
 * object with no live row (an offline-GC orphan → 404). We therefore refuse it
 * BEFORE any network call rather than storing it untracked; the server
 * enforces the same rule independently (a client can be bypassed).
 * @param file - The media file to upload.
 * @param projectId - Owning project (authorizes the presign).
 * @param deps - Injected config / hash / network / result callbacks.
 */
export async function runMediaUpload(
  file: File,
  projectId: string,
  deps: MediaUploadDeps,
): Promise<void> {
  try {
    const cfg = await deps.getUploadConfig();
    const hash = await deps.hashFile(file);
    if (hash === null) {
      // Refused up front: nothing presigned, nothing PUT, no bandwidth burnt.
      deps.onFailure('hash');
      return;
    }
    const res = await retryTransient(
      () =>
        deps.presign({
          filename: file.name,
          contentType: file.type,
          projectId,
          size: file.size,
          hash,
        }),
      {
        attempts: cfg.clientMaxAttempts,
        baseDelayMs: cfg.clientRetryBaseDelayMs,
        ...(deps.sleep !== undefined && { sleep: deps.sleep }),
      },
    );
    if (isDedupHit(res)) {
      // Instant dedup (presign already returned the existing row's canonical).
      // Still report (registers the audit sinks + re-verifies) → pin the canonical.
      const report = await deps.onUploaded?.({
        dedup: true,
        kind: res.kind,
        fileUrl: res.fileUrl,
        hash,
      });
      deps.onSuccess(report?.fileUrl ?? res.fileUrl);
      return;
    }
    await deps.putFile(res.uploadUrl, file, cfg);
    // §4.1 step 7: the presign `fileUrl` is a TEMP key — do NOT pin it. Report
    // → the server returns the REGISTERED row's canonical → pin THAT. The node
    // stays handling until now; a report rejection → catch → onFailure (Retry).
    const report = await deps.onUploaded?.({
      key: res.key,
      kind: res.kind,
      fileUrl: res.fileUrl,
      hash,
    });
    deps.onSuccess(report?.fileUrl ?? res.fileUrl);
  } catch (err) {
    deps.onFailure(failureReasonOf(err));
  }
}

/** The network + result sinks for {@link runVideoUploadWithCover} (#1816). */
export interface VideoWithCoverDeps {
  /** Fetch the session-cached upload knobs (shared by both uploads). */
  getUploadConfig: MediaUploadDeps['getUploadConfig'];
  /** Hash a file for dedup (shared). */
  hashFile: MediaUploadDeps['hashFile'];
  /** Request a presigned URL / dedup hit (shared). */
  presign: MediaUploadDeps['presign'];
  /** PUT a file with retries (shared). */
  putFile: MediaUploadDeps['putFile'];
  /** Backoff sleep override (tests only). */
  sleep?: MediaUploadDeps['sleep'];
  /**
   * BOTH uploads succeeded → write `content` + `coverUrl` onto the node in one
   * atomic write (`completeNodeHandling`). The only success path. `coverUrl` is
   * the cover's REGISTERED canonical, resolved by the server from the cover's
   * hash — never the cover's presign temp key (§0 rule 2 / §4.5). A cover the
   * server cannot resolve fails the whole report (422 → `onFailure`, Retry),
   * so reaching here without one is impossible for a video (#1816 atomicity).
   */
  onSuccess: (videoUrl: string, coverUrl: string | undefined) => void;
  /**
   * EITHER upload failed → the node stays unwritten (`failNodeHandling`, retry
   * both). A successfully-uploaded half becomes an accepted orphan asset
   * (design C2/C5); it is deliberately NOT reported (no phantom node-history
   * row / attribution for an aborted atomic upload). `reason` distinguishes a
   * hashing failure (reload) from a transient upload failure (retry).
   */
  onFailure: (reason: UploadFailureReason) => void;
  /**
   * Video asset ledger report — fired ONLY on full success. Carries BOTH the
   * video info AND the cover info (#1824): the caller adds the nodeId (the
   * node-history 'upload' row's source) and rides the cover's verifiable ref
   * (`cover_hash`) on the video report, so the server reads the cover's
   * studio_assets row (#1826 §4.5, `cover_key` retired with the tenant-neutral
   * key) for the node-history + activity-feed thumbnails. RETURNS the registered
   * canonical (video `fileUrl` + resolved `coverUrl`) — the node pins those, not
   * the presign temp keys (§0 rule 2). The orchestrator awaits it before
   * `onSuccess`; a rejection → `onFailure` (Retry).
   */
  onVideoUploaded?: (
    videoInfo: UploadedInfo,
    coverInfo: UploadedInfo,
  ) => Promise<UploadReportResult>;
  /**
   * Cover asset ledger report — fired ONLY on full success. Carries the cover
   * File so the caller can build the report metadata (filename / size). The
   * caller omits the nodeId (F3): a cover is a derived asset, not node content,
   * so a node_id would write a bogus node-history row (mirrors `runFocusCrop`).
   * Returns a Promise the orchestrator AWAITS: the cover's studio_assets row
   * must be committed before the video report reads it by hash (#1826 §4.5).
   */
  onCoverUploaded?: (info: UploadedInfo, coverFile: File) => void | Promise<void>;
}

/**
 * Upload one file through {@link runMediaUpload}, resolving its public URL +
 * storage identity or rejecting on failure — the Promise adapter that lets
 * {@link runVideoUploadWithCover} join the video and cover with `Promise.all`.
 * @param file - The file to upload.
 * @param projectId - Owning project (authorizes the presign).
 * @param shared - The shared upload network deps.
 * @returns The uploaded URL + storage identity.
 * @throws {Error} When config / presign / PUT finally fails.
 */
function uploadOneMedia(
  file: File,
  projectId: string,
  shared: Pick<
    VideoWithCoverDeps,
    'getUploadConfig' | 'hashFile' | 'presign' | 'putFile' | 'sleep'
  >,
): Promise<{ url: string; info: UploadedInfo }> {
  return new Promise((resolve, reject) => {
    // Capture the storage identity from onUploaded (fires first, non-reporting
    // here → returns undefined), then resolve on onSuccess (fires last with the
    // presign URL). runVideoUploadWithCover reports both halves + pins the
    // registered canonical later; this sub-upload just carries the temp URL.
    let info: UploadedInfo | undefined;
    void runMediaUpload(file, projectId, {
      getUploadConfig: shared.getUploadConfig,
      hashFile: shared.hashFile,
      presign: shared.presign,
      putFile: shared.putFile,
      onSuccess: (fileUrl) => {
        if (info) resolve({ url: fileUrl, info });
      },
      onFailure: (reason) => reject(new MediaUploadError(reason)),
      onUploaded: (i) => {
        info = i;
        return undefined;
      },
      ...(shared.sleep !== undefined && { sleep: shared.sleep }),
    });
  });
}

/**
 * Upload a video and its extracted cover ATOMICALLY (#1816): the two run
 * concurrently, EACH with its own transient retry ({@link runMediaUpload} →
 * presign and PUT, each retried under its own rules). The node is written only when BOTH
 * FINALLY succeed. If either FINALLY fails (after its own retries are
 * exhausted), the whole thing aborts with no write — a video never lands
 * without its cover and a cover never lands without its video; the failed node
 * then offers a manual Retry that re-runs the whole upload from scratch. A
 * single transient hiccup does NOT re-upload the other half — each half only
 * retries itself. Never throws — both outcomes route through `onSuccess` /
 * `onFailure`, and the ledger reports fire only on full success (an aborted
 * half is an accepted orphan, not a phantom node-history row). Mirrors
 * `runFocusCrop`'s injected pipeline.
 * @param videoFile - The video File to upload.
 * @param coverFile - The pre-flight-extracted cover File (PNG).
 * @param projectId - Owning project (authorizes the presigns).
 * @param deps - Injected shared upload network + atomic result sinks.
 */
export async function runVideoUploadWithCover(
  videoFile: File,
  coverFile: File,
  projectId: string,
  deps: VideoWithCoverDeps,
): Promise<void> {
  const shared = {
    getUploadConfig: deps.getUploadConfig,
    hashFile: deps.hashFile,
    presign: deps.presign,
    putFile: deps.putFile,
    ...(deps.sleep !== undefined && { sleep: deps.sleep }),
  };
  try {
    const [video, cover] = await Promise.all([
      uploadOneMedia(videoFile, projectId, shared),
      uploadOneMedia(coverFile, projectId, shared),
    ]);
    // Both landed. Register the cover FIRST and AWAIT it: the video report rides
    // only the cover's hash, and the server reads the cover's studio_assets row
    // by that hash (#1826 §4.5) — so the row must be committed before the video
    // report fires, else the server cannot resolve it and 422s the video.
    // A cover-report rejection PROPAGATES (user 2026-07-26): #1816 makes the two
    // halves atomic, so a cover that cannot be REGISTERED fails the upload
    // exactly like a cover that could not be PUT.
    await deps.onCoverUploaded?.(cover.info, coverFile);
    // §4.1 step 7: the presign video/cover urls are TEMP keys. The video report
    // returns the REGISTERED canonical (video fileUrl + resolved coverUrl) — pin
    // THOSE, never the temp keys (§0 rule 2). A report rejection → catch →
    // onFailure (retry both). The node stays handling until now.
    const report = await deps.onVideoUploaded?.(video.info, cover.info);
    // The cover is pinned ONLY from the report's resolved canonical, with NO
    // `?? cover.url` fallback: that would re-pin the cover's presign TEMP key —
    // an offline-GC orphan → 404 (§0 rule 2 / §4.5). A cover the server cannot
    // resolve 422s the report above, so a video that reaches here always has
    // one. The video half's `?? video.url` is defense-in-depth for the
    // unwired-reporter case (never in production — the atomic path always wires
    // the reporter, so `report.fileUrl` is always the registered canonical).
    deps.onSuccess(report?.fileUrl ?? video.url, report?.coverUrl);
  } catch (err) {
    deps.onFailure(failureReasonOf(err));
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
  /** Fetch the session-cached upload knobs (media path). */
  getUploadConfig: MediaUploadDeps['getUploadConfig'];
  /** Hash the file for dedup (media path). */
  hashFile: MediaUploadDeps['hashFile'];
  /** Request a presigned upload URL / dedup hit (media path). */
  presign: MediaUploadDeps['presign'];
  /** PUT the file with retries (media path). */
  putFile: MediaUploadDeps['putFile'];
  /** Backoff sleep override (tests only). */
  sleep?: MediaUploadDeps['sleep'];
  /** Read / extract a non-media file's text locally (the text path). */
  extractText: (file: File) => Promise<string>;
  /**
   * Extract a video's first frame as a cover blob (#1816), or `null` when the
   * browser cannot decode it. Present only for the video path (production binds
   * `extractVideoFirstFrame`). When a video file arrives WITH this dep, the fill
   * runs the PRE-FLIGHT gate below (extract before opening the lease) + the
   * atomic video-with-cover upload; absent, a video falls back to a plain
   * cover-less upload (legacy).
   */
  extractVideoCover?: (file: File) => Promise<Blob | null>;
  /**
   * Busy gate (#1580 #7, user decision 2026-07-03): true when the node is
   * already handling — a second fill is refused up front instead of
   * silently racing the live lease holder.
   */
  isHandling: (nodeId: string) => boolean;
  /**
   * Called (instead of any work) when the picked file's classification does
   * not match the target node's modality — the type gate below.
   */
  onTypeMismatch: (nodeId: string) => void;
  /** Called (instead of any work) when the busy gate refuses the fill. */
  onBusy: (nodeId: string) => void;
  /**
   * Called (instead of any work) when the video pre-flight can't extract a
   * cover (#1816) — the empty node is left untouched (no lease, no upload). The
   * caller turns this into a friendly "unsupported codec" toast.
   */
  onExtractRejected?: (nodeId: string) => void;
  /**
   * Called INSTEAD of {@link FillNodeDeps.setError} when the browser could not
   * fingerprint the file, so the upload was refused up front (no hash → no
   * ledger row → the node would pin an orphan). The caller owns the whole
   * outcome here because it differs from a transient failure in two ways: the
   * remedy (reload — the hashing worker's own code is what broke) can only be
   * said in a localized toast, and the file must NOT be stashed for Retry,
   * since retrying on this page hits the same broken worker. Absent → falls
   * back to the plain error write-back.
   */
  onHashUnavailable?: (nodeId: string, file: File, lease: UploadLease) => void;
  /**
   * Open the lease (`handling` + owner triple); `undefined` = node gone.
   * The returned token threads through to the write-backs below.
   */
  setHandling: (nodeId: string) => UploadLease | undefined;
  /**
   * Leased content write-back; returns false when the lease was superseded
   * (the node's final content belongs to the final lease owner). `coverUrl`
   * (#1816) is passed on the atomic video path so `content` + cover land in one
   * transaction; omitted for image / audio / text.
   */
  setContent: (
    nodeId: string,
    content: string,
    lease: UploadLease,
    coverUrl?: string,
  ) => boolean;
  /** Leased error write-back (fixed-English wire string — never a toast). */
  setError: (nodeId: string, message: string, lease: UploadLease) => boolean;
  /**
   * `/uploaded` handshake reporter (media path) — called after the PUT with the
   * storage identity + the node it landed on. RETURNS the registered canonical
   * (`fileUrl` + `coverUrl` for a video) which the node pins (§0 rule 2 / §4.1
   * step 7), never the presign temp key. The orchestrator AWAITS it before
   * writing the node; a rejection → the upload fails → Retry. `coverInfo` is
   * present ONLY on the atomic video path (#1824).
   */
  onUploaded?: (
    nodeId: string,
    info: UploadedInfo,
    coverInfo?: UploadedInfo,
  ) => Promise<UploadReportResult>;
  /**
   * Cover asset ledger reporter (#1816 atomic video path) — called after a
   * successful atomic upload with the COVER's storage identity + File. The
   * caller reports it WITHOUT a nodeId (F3): a cover is a derived asset, not
   * node content, so a node_id would write a bogus node-history row. Returns a
   * Promise the atomic upload AWAITS (the cover row must commit before the video
   * report reads it by hash, #1826 §4.5) — the type must carry the promise so
   * the ordering can't be silently dropped through this delegation layer.
   */
  onCoverUploaded?: (info: UploadedInfo, coverFile: File) => void | Promise<void>;
}

/**
 * Write a refused/failed upload back onto the node, wording it by cause. Shared
 * by the plain and the atomic-video paths so both stay identical.
 *
 * A hashing failure is NOT a transient upload failure: retrying on the same
 * page hits the same broken worker, so the node says the file could not be
 * read and the caller additionally toasts the remedy (reload).
 * @param reason - Why the upload ended.
 * @param nodeId - Node being filled.
 * @param file - The picked file (its name goes into the wire string).
 * @param lease - The owner triple guarding the write-back.
 * @param deps - The fill sinks (error write-back + the hash-toast hook).
 */
function uploadFailed(
  reason: UploadFailureReason,
  nodeId: string,
  file: File,
  lease: UploadLease,
  deps: Pick<FillNodeDeps, 'setError' | 'onHashUnavailable'>,
): void {
  if (reason === 'storage') {
    deps.setError(nodeId, `Storage is full: ${file.name}`, lease);
    return;
  }
  if (reason === 'hash') {
    if (deps.onHashUnavailable) {
      deps.onHashUnavailable(nodeId, file, lease);
      return;
    }
    deps.setError(nodeId, `Could not read file: ${file.name}`, lease);
    return;
  }
  deps.setError(nodeId, `Upload failed: ${file.name}`, lease);
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
 *
 * Type gate (user bug 2026-07-03): the picker's `accept` filter is advisory —
 * macOS lets an `audio/*` picker select `.mp4` (the MP4 container family
 * includes audio-only `audio/mp4`), and nothing downstream checked the file
 * against the node. The file's classification must match the target node's
 * modality or the fill is refused before any lease is taken; an audio-only
 * container (`audio/mp4`) still classifies as audio and passes.
 * @param nodeId - The existing node to fill.
 * @param file - The picked file.
 * @param targetModality - The target node's modality; the file must classify to it.
 * @param projectId - Owning project (authorizes the presign).
 * @param deps - Injected upload network + content / error sinks.
 */
export async function fillNodeFromFile(
  nodeId: string,
  file: File,
  targetModality: UploadNodeSpec['nodeType'],
  projectId: string,
  deps: FillNodeDeps,
): Promise<void> {
  const spec = fileToNodeSpec(file);
  if (spec.nodeType !== targetModality) {
    deps.onTypeMismatch(nodeId);
    return;
  }
  if (deps.isHandling(nodeId)) {
    deps.onBusy(nodeId);
    return;
  }
  // Video pre-flight (#1816): extract the cover BEFORE opening the lease, so a
  // codec the browser can't decode leaves the empty node untouched (no
  // handling state) instead of failing mid-upload. Only when the extractor is
  // wired (production always wires it) — a video without it falls back to a
  // plain cover-less upload below.
  let coverFile: File | undefined;
  if (spec.nodeType === 'video' && deps.extractVideoCover) {
    const coverBlob = await deps.extractVideoCover(file);
    if (!coverBlob) {
      deps.onExtractRejected?.(nodeId);
      return;
    }
    coverFile = videoCoverFile(coverBlob, file.name);
  }
  const lease = deps.setHandling(nodeId);
  if (!lease) return;
  if (spec.needsUpload) {
    if (coverFile) {
      // Atomic video + cover: the node gets content + coverUrl only when BOTH
      // uploads succeed; either failure retries both (never video-only).
      await runVideoUploadWithCover(file, coverFile, projectId, {
        getUploadConfig: deps.getUploadConfig,
        hashFile: deps.hashFile,
        presign: deps.presign,
        putFile: deps.putFile,
        onSuccess: (videoUrl, coverUrl) =>
          deps.setContent(nodeId, videoUrl, lease, coverUrl),
        onFailure: (reason) => uploadFailed(reason, nodeId, file, lease, deps),
        onVideoUploaded: (info, coverInfo) =>
          deps.onUploaded?.(nodeId, info, coverInfo) ??
          Promise.resolve({ fileUrl: info.fileUrl }),
        onCoverUploaded: (info, cf) => deps.onCoverUploaded?.(info, cf),
        ...(deps.sleep !== undefined && { sleep: deps.sleep }),
      });
      return;
    }
    await runMediaUpload(file, projectId, {
      getUploadConfig: deps.getUploadConfig,
      hashFile: deps.hashFile,
      presign: deps.presign,
      putFile: deps.putFile,
      onSuccess: (fileUrl) => deps.setContent(nodeId, fileUrl, lease),
      onFailure: (reason) => uploadFailed(reason, nodeId, file, lease, deps),
      onUploaded: (info) =>
        deps.onUploaded?.(nodeId, info) ??
        Promise.resolve({ fileUrl: info.fileUrl }),
      ...(deps.sleep !== undefined && { sleep: deps.sleep }),
    });
    return;
  }
  try {
    deps.setContent(nodeId, await deps.extractText(file), lease);
  } catch {
    deps.setError(nodeId, `Extraction failed: ${file.name}`, lease);
  }
}

/** A minimal canvas node shape for asset-delete accounting (pure). */
export interface AssetNodeLike {
  id: string;
  type?: string;
  data?: {
    content?: unknown;
    coverUrl?: unknown;
    focusImages?: unknown;
    styleImageUrl?: unknown;
  };
}

/**
 * Every asset URL a node holds in its video slots.
 *
 * Both halves of the delete accounting read this: the set of URLs a surviving
 * node keeps alive, and the question "does any node still hold this URL".
 * Deriving them from the slot registry is what keeps the two in step with each
 * other and with the slots themselves.
 *
 * A slot's poster counts too — it is a second uploaded asset, copied into the
 * slot at pick time on the same terms as the asset it stands for.
 * @param data - A node's data map, whatever shape it is in.
 * @returns Every URL this node's slots hold.
 */
function videoSlotUrls(data: unknown): string[] {
  const bag = data as Record<string, unknown> | undefined;
  const urls: string[] = [];
  for (const spec of Object.values(VIDEO_SLOTS) as VideoSlotSpec[]) {
    const pick = readSlotPick(spec, bag?.[spec.field]);
    if (!pick) continue;
    urls.push(pick.url);
    if (pick.thumbnail && pick.thumbnail !== pick.url) urls.push(pick.thumbnail);
  }
  return urls;
}

/** One asset-delete report entry (activity feed). */
export interface DeletedAssetEntry {
  fileUrl: string;
  kind: string;
  nodeId: string;
  spaceId: string;
}

/**
 * Whether an asset URL is safe to put in a delete-side ledger report — a
 * parse-level check mirroring the server's `z.string().url()` (round-3: the
 * old prefix regex accepted strings like `https://a b` that the server
 * rejects with a whole-batch 400, so ONE malformed remote crop URL poisoned
 * every other entry in a multi-node delete report).
 * @param url - The candidate asset URL.
 * @returns True for a parseable http(s) URL.
 */
export function isReportableAssetUrl(url: string): boolean {
  // Mirrors the FULL server field contract (`z.string().url().max(2048)`,
  // routes/assets.ts) — a parseable-but-overlong URL still 400s the whole
  // batch (adversarial round-4).
  if (url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Compute the asset-delete report entries for a set of deleted nodes
 * (ADR 2026-07-04 project-activity-feed).
 *
 * For each deleted media node (image / video / audio) it reports BOTH
 * the primary asset (`data.content`) AND the cover (`data.coverUrl`) —
 * each is a stored object the node owned. It SKIPS any URL still
 * referenced by a SURVIVING node (a URL in `allNodes` minus the deleted
 * set): pasted copies share a content URL, so deleting one copy leaves
 * the asset in use and it must not be reported deleted (which would
 * mislead the audit feed + a future GC).
 * @param deletedNodes - The nodes being removed.
 * @param allNodes - The current node set (still includes the deleted
 *   ones — Yjs removal propagates async; the deleted set is excluded here).
 * @param spaceId - The space the nodes live in.
 * @returns The report entries (content + cover, unreferenced only).
 */
export function computeDeletedAssetEntries(
  deletedNodes: ReadonlyArray<AssetNodeLike>,
  allNodes: ReadonlyArray<AssetNodeLike>,
  spaceId: string,
): DeletedAssetEntry[] {
  const deletedIds = new Set(deletedNodes.map((n) => n.id));
  const survivingUrls = new Set<string>();
  for (const n of allNodes) {
    if (deletedIds.has(n.id)) continue;
    if (typeof n.data?.content === 'string') survivingUrls.add(n.data.content);
    if (typeof n.data?.coverUrl === 'string') survivingUrls.add(n.data.coverUrl);
    // The style slot (#333) holds a copied URL — dedup can make it equal a
    // crop's asset URL, so it keeps the asset alive too (round-12).
    if (typeof n.data?.styleImageUrl === 'string') {
      survivingUrls.add(n.data.styleImageUrl);
    }
    // Every video-panel slot (#1896 onward) holds a copied URL on the same
    // terms as the style slot. Read off the registry rather than listed here:
    // the first two were added one PR at a time, and a slot left out of a
    // hand-kept list reports an asset the video node is still generating from
    // — silently, until someone deletes the node it was picked from (#1918).
    for (const url of videoSlotUrls(n.data)) survivingUrls.add(url);
    // Focus crops (#1782) are uploaded assets too — a crop URL held by a
    // surviving node keeps the asset alive (adversarial round-2).
    for (const crop of validFocusImages(n.data?.focusImages)) {
      survivingUrls.add(crop.url);
    }
  }
  const mediaTypes = new Set(['image', 'video', 'audio']);
  return deletedNodes.flatMap((node) => {
    const out: DeletedAssetEntry[] = [];
    if (node.type !== undefined && mediaTypes.has(node.type)) {
      for (const url of [node.data?.content, node.data?.coverUrl]) {
        if (
          typeof url === 'string' &&
          isReportableAssetUrl(url) &&
          !survivingUrls.has(url)
        ) {
          out.push({ fileUrl: url, kind: node.type, nodeId: node.id, spaceId });
        }
      }
    }
    // A deleted node takes its focus crops with it — report each crop asset
    // unless the same URL survives elsewhere (dedup can share URLs). Crops
    // are always images regardless of the holding node's type.
    for (const crop of validFocusImages(node.data?.focusImages)) {
      if (isReportableAssetUrl(crop.url) && !survivingUrls.has(crop.url)) {
        out.push({ fileUrl: crop.url, kind: 'image', nodeId: node.id, spaceId });
      }
    }
    return out;
  });
}

/**
 * Whether an asset URL is still referenced by any node — content, cover,
 * style slot (#333, round-12), focus crop (#1782), or anything held in a
 * video-panel slot (#1896 onward, read off the registry rather than listed
 * here). The rail's crop ✕ reports the asset deleted only when this is
 * false; call it AFTER the removal write so the removed instance is
 * naturally excluded (adversarial round-2).
 * @param url - The asset URL to check.
 * @param nodes - The current canvas nodes (post-removal).
 * @returns True when any node still references the URL.
 */
export function assetUrlSurvives(
  url: string,
  // `data?: object` (not the field shape): the all-optional field object is
  // a WEAK TYPE, and view variants with none of the fields (GroupNodeView)
  // would fail assignability even though reading them is safe.
  nodes: ReadonlyArray<{ data?: object }>,
): boolean {
  for (const n of nodes) {
    const data = n.data as AssetNodeLike['data'];
    if (
      data?.content === url ||
      data?.coverUrl === url ||
      data?.styleImageUrl === url
    ) {
      return true;
    }
    // Same registry, same reason as the surviving-set above: the two lists
    // are each other's other half, and a slot missing from either one lets
    // its asset be reported as unused.
    if (videoSlotUrls(data).includes(url)) {
      return true;
    }
    if (validFocusImages(data?.focusImages).some((c) => c.url === url)) {
      return true;
    }
  }
  return false;
}
