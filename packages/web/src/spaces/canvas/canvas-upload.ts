// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { validFocusImages } from '@web/data/focus-images';
import {
  isAlreadyStored,
  UploadNotOpenedError,
  type IngestOutcome,
  type UploadTicket,
  type UploadTicketResponse,
} from '@web/data/upload/ingest-upload';
import {
  errorStatus,
  retryTransient,
  STORAGE_FULL_STATUS,
  type UploadClientConfig,
} from '@web/data/upload/upload-retry';
import {
  VIDEO_SLOTS,
  readSlotPick,
} from '@web/spaces/canvas/generate/video-slots';
import type { VideoSlotSpec } from '@web/spaces/canvas/generate/video-slots';

/**
 * Pure canvas-upload classification + the media upload orchestrator. Classify
 * maps a file's MIME type to the canvas node it becomes; the orchestrator asks
 * for a ticket, sends the bytes to the ingest Worker, and reports the outcome
 * through injected callbacks (kept dependency-injected so the async flow is
 * unit-tested without the network or Yjs). Media files (image / audio / video)
 * become a media node whose content the server writes through Yjs; every
 * non-media file becomes a text node whose content is read or extracted
 * locally (see `text-extract`), so no file is ever rejected.
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
 * Where an upload lands and what it is for.
 *
 * All of it is checked against this user's access when the ticket is issued
 * and then stored on the grant, so what the Worker reports back is read
 * against context we hold rather than context a client could restate.
 */
export interface UploadContext {
  /** Owning project, which gates the ticket. */
  projectId: string;
  /**
   * The node's fencing gen at the moment handling opened. It rides the ticket
   * and comes back on the event that ends the node's handling, so a stale
   * attempt's outcome cannot overwrite a newer one's. An upload with no node
   * carries zero.
   */
  leaseGen: number;
  /** The node the bytes land on, when this upload has one. */
  nodeId?: string;
  /** The space that node lives in. */
  spaceId?: string;
  /** `mini_tool` for a mini-tool product. */
  source?: 'mini_tool';
  /** The mini-tool's name when `source` says so. */
  toolName?: string;
  /** True for a byproduct, registered without an activity-feed row of its own. */
  derived?: true;
}

/**
 * Why an upload ended in `onFailure` — the caller picks the message from this,
 * and whether the node's own failure is the browser's to write.
 *
 * The dividing line is the Durable Object (design §5.5), which the Worker
 * creates when the upload is opened — one request past the ticket. Until it
 * exists nothing anywhere holds this upload and nobody will ever announce how
 * it ended: the browser owns the outcome. Once it exists it holds an alarm on
 * this upload and reports whichever way it ends, so the node's state is the
 * server's — writing a failure over it would fence out the announcement that
 * is still coming.
 *
 * `hash` — the browser could not fingerprint the file (worker / WASM / read
 * failure), which no retry of the SAME page fixes: the fix is a reload.
 * `storage` — the studio's account is out of room (#89), which no retry fixes
 * either, for the opposite reason: nothing is broken, there is simply nowhere
 * to put the bytes until the admin acts.
 * `ticket` — the knobs, the ticket request, or opening the upload failed. A
 * retry can fix it.
 * `transfer` — a part or the completion failed, with the upload open.
 */
export type UploadFailureReason = 'hash' | 'storage' | 'ticket' | 'transfer';

/**
 * Whether the browser writes this failure onto the node itself.
 *
 * True only for the reasons that arise before the upload is open. Past that
 * point the node is left in handling and the server announces the outcome —
 * which it does whether the browser is still there or not.
 * @param reason - Why the upload ended.
 * @returns True when the caller writes the node's failure.
 */
export function browserOwnsFailure(reason: UploadFailureReason): boolean {
  return reason !== 'transfer';
}

/**
 * Say which failure a ticket request ended in.
 *
 * A 507 answer means the account is out of room; anything else is transient as
 * far as the user is concerned. Hashing is not read off an error at all — it is
 * refused before anything is sent.
 * @param err - The rejection value.
 * @returns The failure reason to report.
 */
function ticketFailureOf(err: unknown): UploadFailureReason {
  return isStorageFull(err) ? 'storage' : 'ticket';
}

/**
 * Whether a rejection is the server saying the account is out of storage.
 *
 * Read off the status rather than the message: the sentence is localized on
 * the server side and matching on it would break the moment anyone edits the
 * copy or a user switches language. Both the status reader and the number
 * itself come from the retry module, which asks the other half of the same
 * question — two copies would have to be kept in step by hand.
 * @param err - The rejection value.
 * @returns True for a 507 answer.
 */
function isStorageFull(err: unknown): boolean {
  return errorStatus(err) === STORAGE_FULL_STATUS;
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
  /** Ask for a ticket, or be told the studio already holds this content. */
  requestTicket: (params: {
    filename: string;
    contentType: string;
    projectId: string;
    size: number;
    /** Mandatory — a hashless upload is refused before it reaches here. */
    hash: string;
    leaseGen: number;
    nodeId?: string;
    spaceId?: string;
    source?: 'mini_tool';
    toolName?: string;
    derived?: true;
  }) => Promise<UploadTicketResponse>;
  /** Send the bytes to the ingest Worker and finish the upload. */
  sendToIngest: (
    file: File,
    ticket: UploadTicket,
    cfg: UploadClientConfig,
  ) => Promise<IngestOutcome>;
  /**
   * The bytes are delivered and the server has them.
   *
   * The URL is what the server filed the content under, when it said. A node
   * ignores it: the server writes the node's content through Yjs, and pinning
   * anything here would be a second writer for the one field that has one
   * (design §6.6). An upload with no node behind it has no other channel and
   * this is what it reads.
   */
  onSuccess: (fileUrl: string | undefined) => void;
  /**
   * Called when the upload cannot complete. `reason` tells the caller which
   * message to show: `hash` (we could not fingerprint the file — reload) vs
   * `upload` (config / ticket / parts failed — retry).
   */
  onFailure: (reason: UploadFailureReason) => void;
  /** Backoff sleep override (tests only — production uses real timers). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Upload a media file (#173 design §4): fetch the knobs → hash the bytes
 * (Web Worker, any size) → ask for a ticket — the studio already holding this
 * content answers instantly and nothing moves — else send the parts to the
 * ingest Worker and complete. The two halves retry under different rules: the
 * ticket request through `retryTransient` on the knobs above, each part inside
 * the shared HTTP transport on its own compiled-in policy. Never throws — both
 * outcomes route through `onSuccess` / `onFailure`.
 *
 * NO HASH, NO UPLOAD (user decision 2026-07-26). The hash the browser computes
 * answers one question — does this studio already hold this content — and the
 * server refuses a request without one, so a file that cannot be fingerprinted
 * is refused here rather than sent and rejected.
 *
 * What happens after the bytes land is not this function's to report. The
 * Worker tells the server, the server writes the node through Yjs, and the
 * node comes out of handling that way (design §5). This returning is only the
 * browser's half being over.
 * @param file - The media file to upload.
 * @param context - Where it lands and what it is for.
 * @param deps - Injected config / hash / network / result callbacks.
 */
export async function runMediaUpload(
  file: File,
  context: UploadContext,
  deps: MediaUploadDeps,
): Promise<void> {
  let cfg: UploadClientConfig;
  let answer: UploadTicketResponse;
  try {
    cfg = await deps.getUploadConfig();
    const hash = await deps.hashFile(file);
    if (hash === null) {
      // Refused up front: nothing asked for, nothing sent, no bandwidth burnt.
      deps.onFailure('hash');
      return;
    }
    answer = await retryTransient(
      () =>
        deps.requestTicket({
          filename: file.name,
          contentType: file.type,
          projectId: context.projectId,
          size: file.size,
          hash,
          leaseGen: context.leaseGen,
          ...(context.nodeId !== undefined && { nodeId: context.nodeId }),
          ...(context.spaceId !== undefined && { spaceId: context.spaceId }),
          ...(context.source !== undefined && { source: context.source }),
          ...(context.toolName !== undefined && { toolName: context.toolName }),
          ...(context.derived !== undefined && { derived: context.derived }),
        }),
      {
        attempts: cfg.clientMaxAttempts,
        baseDelayMs: cfg.clientRetryBaseDelayMs,
        ...(deps.sleep !== undefined && { sleep: deps.sleep }),
      },
    );
  } catch (err) {
    deps.onFailure(ticketFailureOf(err));
    return;
  }

  if (isAlreadyStored(answer)) {
    // Nothing moves. The server has already written the node's history and
    // published what ends its handling.
    deps.onSuccess(answer.fileUrl);
    return;
  }

  // From here on the outcome is announced whether or not this browser is still
  // listening — from the moment the Worker has the upload open, which is the
  // first thing this step does.
  try {
    const outcome = await deps.sendToIngest(file, answer, cfg);
    deps.onSuccess(outcome.fileUrl);
  } catch (err) {
    deps.onFailure(err instanceof UploadNotOpenedError ? 'ticket' : 'transfer');
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
  /** Ask for an upload ticket, or be told the content is already held. */
  requestTicket: MediaUploadDeps['requestTicket'];
  /** Send the bytes to the ingest Worker (media path). */
  sendToIngest: MediaUploadDeps['sendToIngest'];
  /**
   * The bytes are delivered, so the file no longer needs holding for a Retry
   * this node is not offered any more. The node's content arrives from the
   * server through Yjs; this callback has nothing to do with it.
   */
  onUploadSettled: (nodeId: string) => void;
  /** Backoff sleep override (tests only). */
  sleep?: MediaUploadDeps['sleep'];
  /** Read / extract a non-media file's text locally (the text path). */
  extractText: (file: File) => Promise<string>;
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
   * Hand the whole outcome of a failed upload to the caller, reason and all.
   *
   * Every reason needs something only the caller can do — pick or clear the
   * Retry stash, and say the remedy in the reader's own language — and what
   * each one needs differs: a hashing refusal must not be stashed (retrying on
   * this page hits the same broken worker) and a full account must not be
   * either (nobody frees storage in the seconds a retry takes), while an
   * ordinary transient failure must be. This started as a hook for the hashing
   * case alone; a second reason with the same needs made the per-reason shape
   * the wrong one, since every new reason then has to be remembered in two
   * places.
   *
   * Required, and with no fallback beside it. An optional one meant this
   * module kept its own copy of the three sentences the user reads, and the
   * single production caller always supplies this — so that copy could never
   * run, could drift from the one that does, and (being the only one a test
   * could reach without wiring the hook) quietly became what the tests
   * measured.
   */
  onUploadFailure: (
    reason: UploadFailureReason,
    nodeId: string,
    file: File,
    lease: UploadLease,
  ) => void;
  /**
   * Open the lease (`handling` + owner triple); `undefined` = node gone.
   * The returned token threads through to the write-backs below.
   */
  setHandling: (nodeId: string) => UploadLease | undefined;
  /**
   * Leased content write-back for the text path, which has no upload: the
   * text is read here and there is nobody else to write it. A media node's
   * content is written by the server through Yjs (design §6.6). Returns false
   * when the lease was superseded.
   */
  setContent: (nodeId: string, content: string, lease: UploadLease) => boolean;
  /** Leased error write-back (fixed-English wire string — never a toast). */
  setError: (nodeId: string, message: string, lease: UploadLease) => boolean;
  /** The space the node lives in, which rides the ticket. */
  spaceId?: string;
}

/**
 * Fill an **existing** (empty) node from a picked file — the double-click /
 * Upload-menu path. Unlike {@link runMediaUpload}'s caller in `processFiles`
 * (which CREATES a node), this writes into a node that already exists:
 * refuse if the node is busy (#1580 #7 gate), open the lease, then media
 * files (image / video / audio) go to the ingest Worker and leave with the
 * node still in handling — what it ends up holding arrives from the server
 * through Yjs — while every other file is read or extracted locally and fills
 * the text here. Failures write a fixed-English error onto the node (shared
 * doc, so never a locale-frozen toast), matching the create-on-drop path's
 * wire strings. Write-backs carry the lease token so a superseded fill cannot
 * clobber a newer owner's work.
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
 * @param projectId - Owning project, which gates the ticket.
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
  const lease = deps.setHandling(nodeId);
  if (!lease) return;
  if (spec.needsUpload) {
    // The node stays in handling when this returns. What it ends up holding —
    // and whether it succeeded at all — arrives from the server through Yjs
    // (design §6.6), so nothing is written here on the way out.
    await runMediaUpload(
      file,
      {
        projectId,
        leaseGen: lease.gen,
        nodeId,
        ...(deps.spaceId !== undefined && { spaceId: deps.spaceId }),
      },
      {
        getUploadConfig: deps.getUploadConfig,
        hashFile: deps.hashFile,
        requestTicket: deps.requestTicket,
        sendToIngest: deps.sendToIngest,
        onSuccess: () => deps.onUploadSettled(nodeId),
        onFailure: (reason) => deps.onUploadFailure(reason, nodeId, file, lease),
        ...(deps.sleep !== undefined && { sleep: deps.sleep }),
      },
    );
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
