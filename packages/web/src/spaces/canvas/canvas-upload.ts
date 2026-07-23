// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { isDedupHit, type PresignResponse } from '@web/data/api/assets';
import { validFocusImages } from '@web/data/focus-images';
import {
  retryTransient,
  type UploadClientConfig,
} from '@web/data/upload/upload-retry';
import { videoCoverFileName } from '@web/spaces/canvas/video-cover-extract';

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

/**
 * The storage identity a finished upload reports to the activity-feed
 * handshake (#1609): regular path carries the stored key; a dedup hit
 * carries `dedup: true` (nothing was uploaded); `hash` is null only when
 * the hashing worker degraded.
 */
export interface UploadedInfo {
  kind: string;
  fileUrl: string;
  /** Content sha256, or null when hashing degraded (worker failure). */
  hash: string | null;
  /** Stored object key (regular path only). */
  key?: string;
  /** True when the presign answered `alreadyExists` (B.2 instant dedup). */
  dedup?: true;
}

/** Injected dependencies for {@link runMediaUpload} (network + result sinks). */
export interface MediaUploadDeps {
  /** Fetch the session-cached upload knobs (`assetsApi.fetchUploadConfig`). */
  getUploadConfig: () => Promise<UploadClientConfig>;
  /** Hash the file for dedup; null = degrade, never rejects (`hashFile`). */
  hashFile: (file: File) => Promise<string | null>;
  /** Request a presigned upload URL or a dedup hit (`assetsApi.presign`). */
  presign: (params: {
    filename: string;
    contentType: string;
    projectId: string;
    size: number;
    hash?: string | null;
  }) => Promise<PresignResponse>;
  /** PUT the file with retries + stall guard (`putFileWithRetry`). */
  putFile: (
    uploadUrl: string,
    file: File,
    cfg: UploadClientConfig,
  ) => Promise<void>;
  /** Called with the public URL once the upload succeeds. */
  onSuccess: (fileUrl: string) => void;
  /** Called (no args) when config/presign/PUT finally fail. */
  onFailure: () => void;
  /**
   * Optional post-success hook carrying the storage identity — the
   * caller reports the upload to the activity-feed handshake with it
   * (fire-and-forget; the canvas write-back never waits on it).
   */
  onUploaded?: (info: UploadedInfo) => void;
  /** Backoff sleep override (tests only — production uses real timers). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Upload a media file (#1609 orchestration): fetch the knobs → hash the
 * bytes (Web Worker, any size) → presign with size + hash — a dedup hit
 * skips the upload entirely and reuses the existing URL (B.2) — else PUT
 * with retries, then report the public URL. presign gets the same
 * 3-attempt transient-retry treatment as the PUT. Never throws — both
 * outcomes route through `onSuccess` / `onFailure` so the caller can
 * write them to Yjs (`completeNodeHandling` / `failNodeHandling`).
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
      deps.onSuccess(res.fileUrl);
      deps.onUploaded?.({ dedup: true, kind: res.kind, fileUrl: res.fileUrl, hash });
      return;
    }
    await deps.putFile(res.uploadUrl, file, cfg);
    deps.onSuccess(res.fileUrl);
    deps.onUploaded?.({ key: res.key, kind: res.kind, fileUrl: res.fileUrl, hash });
  } catch {
    deps.onFailure();
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
   * atomic write (`completeNodeHandling`). The only success path.
   */
  onSuccess: (videoUrl: string, coverUrl: string) => void;
  /**
   * EITHER upload failed → the node stays unwritten (`failNodeHandling`, retry
   * both). A successfully-uploaded half becomes an accepted orphan asset
   * (design C2/C5); it is deliberately NOT reported (no phantom node-history
   * row / attribution for an aborted atomic upload).
   */
  onFailure: () => void;
  /**
   * Video asset ledger report — fired ONLY on full success. The caller adds
   * the nodeId (it becomes the node-history 'upload' row's source).
   */
  onVideoUploaded?: (info: UploadedInfo) => void;
  /**
   * Cover asset ledger report — fired ONLY on full success. Carries the cover
   * File so the caller can build the report metadata (filename / size). The
   * caller omits the nodeId (F3): a cover is a derived asset, not node content,
   * so a node_id would write a bogus node-history row (mirrors `runFocusCrop`).
   */
  onCoverUploaded?: (info: UploadedInfo, coverFile: File) => void;
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
    let url = '';
    void runMediaUpload(file, projectId, {
      getUploadConfig: shared.getUploadConfig,
      hashFile: shared.hashFile,
      presign: shared.presign,
      putFile: shared.putFile,
      onSuccess: (fileUrl) => {
        url = fileUrl;
      },
      onFailure: () => reject(new Error('media upload failed')),
      onUploaded: (info) => resolve({ url, info }),
      ...(shared.sleep !== undefined && { sleep: shared.sleep }),
    });
  });
}

/**
 * Upload a video and its extracted cover ATOMICALLY (#1816): the two run
 * concurrently, EACH with its own transient retry ({@link runMediaUpload} →
 * presign + PUT, 3 attempts apiece). The node is written only when BOTH
 * FINALLY succeed. If either FINALLY fails (after its own retries are
 * exhausted), the whole thing aborts with no write — a video never lands
 * without its cover and a cover never lands without its video; the failed node
 * then offers a manual Retry that re-runs the whole upload from scratch. A
 * single transient hiccup does NOT re-upload the other half — each half only
 * retries itself. Never throws — both outcomes route through `onSuccess` /
 * `onFailure`, and the ledger reports fire only on full success (an aborted
 * half is an accepted orphan, not a phantom node-history row). Mirrors
 * {@link runFocusCrop}'s injected pipeline.
 * @param videoFile - The video File to upload.
 * @param coverFile - The pre-flight-extracted cover File (JPEG).
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
    // Both landed — report the assets, then write content + cover in one go.
    deps.onVideoUploaded?.(video.info);
    deps.onCoverUploaded?.(cover.info, coverFile);
    deps.onSuccess(video.url, cover.url);
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
   * Optional activity-feed handshake reporter (media path only) — called
   * after a successful upload with the storage identity + the node it
   * landed on. Fire-and-forget at the caller.
   */
  onUploaded?: (nodeId: string, info: UploadedInfo) => void;
  /**
   * Cover asset ledger reporter (#1816 atomic video path) — called after a
   * successful atomic upload with the COVER's storage identity + File. The
   * caller reports it WITHOUT a nodeId (F3): a cover is a derived asset, not
   * node content, so a node_id would write a bogus node-history row.
   */
  onCoverUploaded?: (info: UploadedInfo, coverFile: File) => void;
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
    coverFile = new File([coverBlob], videoCoverFileName(file.name), {
      type: 'image/jpeg',
    });
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
        onFailure: () =>
          deps.setError(nodeId, `Upload failed: ${file.name}`, lease),
        onVideoUploaded: (info) => deps.onUploaded?.(nodeId, info),
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
      onFailure: () => deps.setError(nodeId, `Upload failed: ${file.name}`, lease),
      onUploaded: (info) => deps.onUploaded?.(nodeId, info),
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
 * style slot (#333, round-12), or focus crop (#1782). The rail's crop ✕
 * reports the asset deleted only when this is false; call it AFTER the
 * removal write so the removed instance is naturally excluded (adversarial
 * round-2).
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
    if (validFocusImages(data?.focusImages).some((c) => c.url === url)) {
      return true;
    }
  }
  return false;
}
