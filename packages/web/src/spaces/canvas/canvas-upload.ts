// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  isUploadableMediaType,
  uploadableSpellings,
  uploadableFormatList,
  reduceMediaType,
} from '@breatic/shared';
import type { MiniToolUploadTag } from '@web/data/upload/ingest-upload';
import { docName } from '@web/data/yjs/manager';
import { canAdd, type SpaceWriteResult } from '@web/data/yjs/space-write';
import {
  runMediaUpload,
  runMediaUploadBatch,
  type BatchUploadDeps,
  type MediaUploadDeps,
  type UploadFailure,
} from '@web/data/upload/media-upload';
import { resolveUploadFailure } from '@web/spaces/canvas/upload-failure';
import type { TrayNotice } from '@web/stores/chat-attachments';
import { useUploadMarksStore, type UploadMarkMessage } from '@web/stores/upload-marks';

/**
 * Canvas-upload classification, and filling a node from a file through the
 * media upload pipeline (`@web/data/upload/media-upload`). Classify maps a
 * file's MIME type to the canvas node it becomes. Media files (image / audio / video)
 * become a media node whose content the server writes through Yjs; every
 * non-media file becomes a text node whose content is read or extracted
 * locally (see `text-extract`). Admission is checked separately by
 * `checkFileAdmission`.
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
export type FileRejection = 'empty' | 'tooLarge' | 'unsupportedType';

/**
 * What the file picker offers for one modality.
 *
 * Derived from the same list the admission gate asks, aliases and all: the
 * picker and the gate answer the same question, so a format shown here and
 * refused there is an offer withdrawn the moment somebody takes it, and one the
 * gate takes but the picker omits is a file the user cannot select. A family
 * wildcard does the first — `image/*` shows HEIC, GIF and AVIF, none of which a
 * model can be given.
 * @param modality - One media kind, or all supported media.
 * @returns A comma-separated `accept` value.
 */
export function uploadAcceptFor(modality: 'image' | 'video' | 'audio' | 'all'): string {
  return uploadableSpellings()
    .filter((type) => modality === 'all' || type.startsWith(`${modality}/`))
    .join(',');
}

/** The media this product lists formats for. */
const LISTED_MEDIA = ['image', 'video', 'audio'] as const;

/**
 * What the refusal sentence needs to name the formats we would have taken.
 *
 * Read off the file the person picked, because that is all the two refusals
 * have in common: the browser's gate sees the file and the edge's answer
 * arrives beside the node the file created. Knowing a format is refused
 * leaves them holding it with nowhere to go, and what we take is on this side
 * of the screen already.
 * @param file - The picked file (only `type` is read).
 * @returns The `select` arm to take and the formats to name in it.
 */
export function refusedFormatParams(file: Pick<File, 'type'>): {
  kind: string;
  formats: string;
} {
  const medium = LISTED_MEDIA.find((name) =>
    reduceMediaType(file.type).startsWith(`${name}/`),
  );
  return medium === undefined
    ? { kind: 'other', formats: '' }
    : { kind: medium, formats: uploadableFormatList(medium) };
}

/**
 * What the Agent tray says about a media file refused for its format.
 * @param file - The file whose medium determines the supported formats.
 * @returns The notice the tray's toast renders.
 */
export function mediaFormatNotice(file: Pick<File, 'name' | 'type'>): TrayNotice {
  return { key: 'unsupportedMedia', filename: file.name, ...refusedFormatParams(file) };
}

/**
 * Decide whether a picked file may become a node, BEFORE anything is created
 * or sent. Both selection paths (the batch drop / picker and the single-node
 * fill) run this, so one rule covers every way a file enters the canvas.
 *
 * Three refusals:
 *   - `empty` — a 0-byte file, whatever its type. It would make an empty node:
 *     nothing to show, nothing to dedup against, and a storage row for no
 *     bytes. Refused for EVERY file, not just uploads, because an empty text
 *     node is just as pointless as an empty image (user decision 2026-07-26).
 *     Needs no config, so it holds even when the cap is unknown.
 *   - `unsupportedType` — a file that would upload, announcing a format the
 *     ticket endpoint refuses. Without this the user picks it, watches a node
 *     appear, and gets a permanent failure offering a retry that cannot
 *     succeed. Asked only of files that would upload: a PDF is read locally
 *     and never reaches storage, so the list is none of its business.
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
  if (!fileToNodeSpec(file).needsUpload) return null;
  if (!isUploadableMediaType(reduceMediaType(file.type))) {
    return 'unsupportedType';
  }
  if (file.size > maxBytes) return 'tooLarge';
  return null;
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
  /** Backoff sleep override (tests only). */
  sleep?: MediaUploadDeps['sleep'];
  /** Read / extract a non-media file's text locally (the text path). */
  extractText: (file: File) => Promise<string>;
  /**
   * Hand the whole outcome of an upload that failed after the server answered
   * to the caller, reason and all. A failure before the answer has no task
   * row and is said on the node itself (inner#1303 §6.7).
   *
   * Every reason needs something only the caller can do — pick or clear the
   * Retry stash, and say the remedy in the user's own language — and what
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
  onUploadFailure: (outcome: UploadFailure, file: File) => void;
  /**
   * Content write-back for the text path, which has no upload: the text is
   * read here and there is nobody else to write it. A media node's content
   * is written by the server through Yjs (design §6.6). Answers whether the
   * Space had room for the text (inner#1790); no answer counts as written.
   */
  setContent: (nodeId: string, content: string) => SpaceWriteResult | void;
  /** The space the node lives in, which rides the ticket and keys its mark. */
  spaceId: string;
  /**
   * The upload mark the caller began on the node when the user asked for
   * this fill (inner#1303 §6.7); this fill ends it.
   */
  markOp: string;
  /** A browser mini-tool's tag, when its export is what is being uploaded. */
  tag?: MiniToolUploadTag;
}

/**
 * Fill an **existing** (empty) node from a picked file — the double-click /
 * Upload-menu path. Unlike {@link runMediaUpload}'s caller in `processFiles`
 * (which CREATES a node), this writes into a node that already exists:
 * media files (image / video / audio) go to the ingest Worker and what the
 * node ends up holding arrives from the server through Yjs, while every other
 * file is read or extracted locally and fills the text here. Failures are
 * handed to the caller's sinks and nothing is written onto the node.
 *
 * Type gate (user bug 2026-07-03): the picker's `accept` filter is advisory —
 * macOS lets an `audio/*` picker select `.mp4` (the MP4 container family
 * includes audio-only `audio/mp4`), and nothing downstream checked the file
 * against the node. The file's classification must match the target node's
 * modality; an audio-only
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
  const marks = useUploadMarksStore.getState();
  const spec = fileToNodeSpec(file);
  if (spec.nodeType !== targetModality) {
    marks.fail(deps.spaceId, nodeId, deps.markOp, { key: 'canvas.upload.typeMismatch' });
    return;
  }
  if (spec.needsUpload) {
    // What the node ends up holding — and whether it succeeded at all —
    // arrives from the server through Yjs (design §6.6), so nothing is written
    // here on the way out.
    await runMediaUpload(
      file,
      { projectId, nodeId, spaceId: deps.spaceId, ...deps.tag },
      {
        getUploadConfig: deps.getUploadConfig,
        hashFile: deps.hashFile,
        requestTicket: deps.requestTicket,
        sendToIngest: deps.sendToIngest,
        // The node's content arrives from the server through Yjs.
        onSuccess: () => undefined,
        ...markedSinks(deps.spaceId, nodeId, deps.markOp, file, deps.onUploadFailure),
        ...(deps.sleep !== undefined && { sleep: deps.sleep }),
      },
    );
    return;
  }
  try {
    const written = deps.setContent(nodeId, await deps.extractText(file));
    if (written && !written.ok) marks.fail(deps.spaceId, nodeId, deps.markOp, TEXT_REFUSAL_MARK);
    else marks.answer(deps.spaceId, nodeId, deps.markOp);
  } catch {
    marks.fail(deps.spaceId, nodeId, deps.markOp, { key: 'canvas.upload.extractionFailed', params: { filename: file.name } });
  }
}

/**
 * What a text node says when the words read from its file were not written
 * because the Space could not take them (inner#1790, design 5.5).
 */
export const TEXT_REFUSAL_MARK: UploadMarkMessage = { key: 'spaces.sizeCap.text' };

/**
 * What a node says when its upload ended before the server answered: the
 * sentence the reason is told in, naming the file and the formats where the
 * sentence does.
 * @param outcome - How the upload ended.
 * @param file - The file.
 * @returns The message.
 */
export function uploadFailureMark(outcome: UploadFailure, file: File): UploadMarkMessage {
  const plan = resolveUploadFailure(outcome);
  return {
    key: plan.kind === 'toastOnly' ? plan.toastKey : 'canvas.upload.failed',
    params: { filename: file.name, ...refusedFormatParams(file) },
  };
}

/**
 * An upload's answer and failure sinks that keep its node's mark (inner#1303
 * §6.7): the answer ends the mark; a failure before it is said on the node;
 * a failure after it has a task row and goes to the caller.
 * @param spaceId - The Space.
 * @param nodeId - The node.
 * @param op - The mark's operation.
 * @param file - The file.
 * @param afterAnswer - Where a failure after the answer goes.
 * @returns The two sinks.
 */
export function markedSinks(
  spaceId: string,
  nodeId: string,
  op: string,
  file: File,
  afterAnswer: (outcome: UploadFailure, file: File) => void,
): Pick<MediaUploadDeps, 'onAnswered' | 'onFailure'> {
  let answered = false;
  return {
    onAnswered: () => {
      answered = true;
      useUploadMarksStore.getState().answer(spaceId, nodeId, op);
    },
    onFailure: (outcome) => {
      if (answered || outcome.taskId !== undefined) afterAnswer(outcome, file);
      else useUploadMarksStore.getState().fail(spaceId, nodeId, op, uploadFailureMark(outcome, file));
    },
  };
}

/** Injected dependencies for {@link fillNodesFromFiles}. */
export interface FillNodesDeps extends BatchUploadDeps {
  /** The Space the nodes live in. */
  spaceId: string;
  /** The browser tool whose export this is. */
  tag: MiniToolUploadTag;
  /** Whether a node is locked, read fresh. */
  isLocked: (nodeId: string) => boolean;
  /** Said once when any node was left out for being locked. */
  onLocked: () => void;
  /** Register a node as busy for as long as `work` runs. */
  track: (nodeId: string, work: Promise<void>) => void;
  /** Hand one file's upload that failed after the answer to the caller, as `fillNodeFromFile` does. */
  onUploadFailure: (outcome: UploadFailure, file: File) => void;
}

/**
 * Fill a browser tool's result nodes with its export in one batch upload
 * (inner#1303 §6.5): a locked node is left out, every other node is
 * registered as busy before anything awaits, and each file's outcome goes to
 * the caller as a single fill's would. What a node ends up holding arrives
 * from the server through Yjs, past the size gate, so a Space that filled
 * after the result nodes were built sends nothing and each node's mark says
 * why (inner#1790, design 5.5).
 * @param entries - Each node and the file it is filled with.
 * @param projectId - The project, which gates the tickets.
 * @param deps - The upload network and the canvas sinks.
 */
export function fillNodesFromFiles(
  entries: readonly { nodeId: string; file: File; markOp: string }[],
  projectId: string,
  deps: FillNodesDeps,
): void {
  const open = entries.filter((entry) => !deps.isLocked(entry.nodeId));
  if (open.length < entries.length) {
    deps.onLocked();
    const marks = useUploadMarksStore.getState();
    for (const entry of entries) {
      if (!open.includes(entry)) marks.answer(deps.spaceId, entry.nodeId, entry.markOp);
    }
  }
  if (open.length === 0) return;
  if (!canAdd(docName.canvasSpace(projectId, deps.spaceId))) {
    const marks = useUploadMarksStore.getState();
    for (const entry of open) marks.fail(deps.spaceId, entry.nodeId, entry.markOp, { key: 'spaces.sizeCap.reason' });
    return;
  }
  const work = runMediaUploadBatch(
    open.map((entry) => ({
      file: entry.file,
      nodeId: entry.nodeId,
      // The node's content arrives from the server through Yjs.
      onSuccess: () => undefined,
      ...markedSinks(deps.spaceId, entry.nodeId, entry.markOp, entry.file, deps.onUploadFailure),
    })),
    { projectId, spaceId: deps.spaceId, ...deps.tag },
    deps,
  );
  for (const entry of open) deps.track(entry.nodeId, work);
}

