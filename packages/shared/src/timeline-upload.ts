// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A Timeline upload's result, written into the Timeline document by collab (inner#1709).
 *
 * The placeholder lives in the Timeline's Yjs document, so the backend announces the upload on the task-events stream
 * and collab writes the placeholder, the way a Document body block receives its upload (`document-upload.ts`). The
 * browser that uploaded the bytes never writes the result.
 */

import { v4 as uuidv4 } from "uuid";
import * as Y from "yjs";

import { documentUploadFailure } from "@shared/document-upload.js";
import { attachTimelineRecord, readTimelineDocument, reconcileTimelineSources } from "@shared/timeline/document.js";
import { compareTimelineIds, orderedTimelineClips } from "@shared/timeline/order.js";
import {
  isPresentableTimelineClip, TimelineAudioClipSchema, TimelineClipSchema, TimelineImageClipSchema, TimelineSourceSchema,
  TimelineVideoClipSchema, type TimelineClip, type TimelineDocumentV1, type TimelineSource, type TimelineUploadClip,
} from "@shared/timeline/schema.js";
import { durationToFrames, timelineSourceRoom, timelineUploadExtent } from "@shared/timeline/time.js";
import type { TaskFailureReason } from "@shared/types/task-failure.js";

/** A finished Timeline upload: its stored address and what registration measured (inner#2171). */
export interface TimelineUploadResult {
  kind: "video" | "image" | "audio";
  url: string;
  /** The video's cover; null for a picture or a sound. */
  coverUrl: string | null;
  mimeType: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

/** The backend took over, finished or failed one Timeline upload. */
export interface TimelineUploadEvent {
  type: "timeline-upload";
  /** Yjs doc name of the Timeline the placeholder lives in. */
  docName: string;
  /** The placeholder's `upload.uploadId`. */
  uploadId: string;
  state: "processing" | "completed" | "failed";
  /** On `completed`. */
  result?: TimelineUploadResult;
  /** On `failed`: the normalised cause. */
  reason?: TaskFailureReason;
}

/** Origin of an upload's landing; no undo manager tracks it, so no user's history holds it. */
export const TIMELINE_UPLOAD_ORIGIN = Symbol("timeline-upload");

/** The fields each registered kind keeps when a placeholder becomes it; anything else on the record is dropped. */
const CLIP_FIELDS: Readonly<Record<TimelineUploadResult["kind"], ReadonlySet<string>>> = {
  video: new Set(Object.keys(TimelineVideoClipSchema.shape)),
  image: new Set(Object.keys(TimelineImageClipSchema.shape)),
  audio: new Set(Object.keys(TimelineAudioClipSchema.shape)),
};

/** The ending a conversion that cannot be made writes: running the upload again reads the same file. */
const UNCONVERTIBLE = { state: "failed", failure: "failed", retryable: false } as const;

/**
 * The source a registered upload is measured by, or undefined when none can be made: a video or sound needs a
 * duration, the registered one or else the one the browser read. It is stored by its address and named after the file
 * the user picked, as an upload of the canvas or a Document is (inner#2171).
 * @param document - The Timeline.
 * @param placeholders - The upload's placeholders.
 * @param result - What registration measured.
 * @returns The source.
 * @throws {never} Never.
 */
function sourceOf(document: TimelineDocumentV1, placeholders: readonly TimelineUploadClip[], result: TimelineUploadResult): TimelineSource | undefined {
  // uuid directly, not ids.ts: a module both entries reach joins the Yjs chunk, and web calls newId from every page.
  const id = uuidv4();
  const stored = { id, url: result.url, name: placeholders[0]?.upload.name, mimeType: result.mimeType };
  const measured = result.width !== null && result.height !== null;
  const size = { width: measured ? result.width : null, height: measured ? result.height : null };
  if (result.kind === "image") return TimelineSourceSchema.safeParse({ ...stored, kind: "image", ...size }).data;
  const duration = result.durationSeconds ?? placeholders.map((clip) => clip.upload.durationSeconds).find((seconds) => seconds !== null);
  if (duration === undefined || duration === null) return undefined;
  const fps = document.settings.fps;
  let extentFrames: number;
  try {
    extentFrames = durationToFrames(duration, fps);
  } catch {
    // A duration that cannot be counted in frames cannot be placed; the placeholder is marked failed.
    return undefined;
  }
  const extent = { timebase: fps, extentFrames, durationSeconds: String(duration), durationOrigin: result.durationSeconds === null ? "decoded" : "registered" };
  const source = result.kind === "video" ? { ...stored, kind: "video", coverUrl: result.coverUrl, ...size, ...extent } : { ...stored, kind: "audio", ...extent };
  return TimelineSourceSchema.safeParse(source).data;
}

/**
 * The clip a placeholder becomes, or null when the asset leaves it no frame. An untrimmed video or sound placeholder
 * takes the asset's whole length up to the start of the next presentable clip on its track; any other video or sound
 * piece is cut to what the asset holds. A picture keeps its length and has in-point 0. Tracks and starts never change.
 * @param document - The Timeline.
 * @param placeholder - The placeholder.
 * @param source - The registered source.
 * @returns The clip, or null.
 * @throws {never} Never.
 */
function convertedClip(document: TimelineDocumentV1, placeholder: TimelineUploadClip, source: TimelineSource): TimelineClip | null {
  const { kind: _kind, upload: _upload, ...placement } = placeholder;
  if (source.kind === "image") return { ...placement, kind: "image", sourceId: source.id, sourceInFrame: 0 };
  const fps = document.settings.fps;
  const untrimmed = placeholder.sourceInFrame === 0 && placeholder.durationFrames === timelineUploadExtent(fps, placeholder)?.extentFrames;
  let room: number;
  try {
    room = timelineSourceRoom(placeholder, source, fps);
  } catch {
    // The source passed its schema, so its rates and duration are valid; a placeholder rate that is not is refused below.
    room = 0;
  }
  const next = orderedTimelineClips(document.clips, placeholder.trackId)
    .find((other) => other.startFrame > placeholder.startFrame && isPresentableTimelineClip(document, other));
  const durationFrames = untrimmed
    ? Math.min(room, next === undefined ? room : next.startFrame - placeholder.startFrame)
    : Math.min(room, placeholder.durationFrames);
  return durationFrames <= 0 ? null : { ...placement, kind: source.kind, sourceId: source.id, durationFrames };
}

/**
 * The placeholder's record as a map, so each field is written alone; a peer may have stored it as a plain value.
 * @param clips - The clips map.
 * @param placeholder - The placeholder as read.
 * @returns The attached map.
 * @throws {Error} When Yjs cannot attach the map.
 */
function recordMap(clips: Y.Map<unknown>, placeholder: TimelineUploadClip): Y.Map<unknown> {
  const stored = clips.get(placeholder.id);
  return stored instanceof Y.Map ? stored as Y.Map<unknown> : attachTimelineRecord(clips, placeholder.id, placeholder);
}

/**
 * Write a placeholder's new `upload` fields when they differ from what it holds.
 * @param clips - The clips map.
 * @param placeholder - The placeholder as read.
 * @param fields - The fields to merge into `upload`.
 * @throws {Error} When Yjs cannot attach the map.
 */
function writeUpload(clips: Y.Map<unknown>, placeholder: TimelineUploadClip, fields: Partial<TimelineUploadClip["upload"]>): void {
  const upload = { ...placeholder.upload, ...fields };
  if (JSON.stringify(upload) !== JSON.stringify(placeholder.upload)) recordMap(clips, placeholder).set("upload", upload);
}

/**
 * The writes one event makes, or nothing when it changes nothing.
 * @param document - The Timeline as read.
 * @param placeholders - The upload's placeholders, by id order.
 * @param event - The upload's event.
 * @returns The writes to run in one transaction, or undefined.
 * @throws {never} Never.
 */
function writesFor(document: TimelineDocumentV1, placeholders: readonly TimelineUploadClip[], event: TimelineUploadEvent): ((clips: Y.Map<unknown>, doc: Y.Doc) => void) | undefined {
  if (event.state === "processing") {
    const waiting = placeholders.filter((clip) => clip.upload.state === undefined);
    return waiting.length === 0 ? undefined : (clips) => { for (const clip of waiting) writeUpload(clips, clip, { state: "processing" }); };
  }
  if (event.state === "failed") {
    const { reason, retryable } = documentUploadFailure(event.reason);
    const ending = { state: "failed", failure: reason, retryable } as const;
    const changed = placeholders.filter((clip) => JSON.stringify({ ...clip.upload, ...ending }) !== JSON.stringify(clip.upload));
    return changed.length === 0 ? undefined : (clips) => { for (const clip of changed) writeUpload(clips, clip, ending); };
  }
  const result = event.result;
  if (result === undefined) return undefined;
  const source = sourceOf(document, placeholders, result);
  return (clips, doc) => {
    for (const placeholder of placeholders) {
      const clip = source === undefined ? undefined : convertedClip(document, placeholder, source);
      if (clip === null) {
        clips.delete(placeholder.id);
        continue;
      }
      // A clip that fails its schema would be left out of every reading, so the placeholder stays and says it failed.
      if (clip === undefined || !TimelineClipSchema.safeParse(clip).success) {
        writeUpload(clips, placeholder, UNCONVERTIBLE);
        continue;
      }
      const target = recordMap(clips, placeholder);
      const keep = CLIP_FIELDS[result.kind];
      for (const key of [...target.keys()]) if (!keep.has(key)) target.delete(key);
      for (const [key, value] of Object.entries(clip)) {
        if (JSON.stringify(target.get(key)) !== JSON.stringify(value)) target.set(key, value);
      }
    }
    if (source !== undefined) reconcileTimelineSources(doc, { [source.id]: source }, [source.id]);
  };
}

/**
 * Write one upload's event into the placeholders waiting for it, in one transaction under `TIMELINE_UPLOAD_ORIGIN`.
 *
 * `processing` marks a placeholder with no state yet; a failure replaces `processing`, and `processing` never replaces
 * a failure. `completed` turns every placeholder of the upload into a clip of the registered kind against one new
 * source, or marks it failed when no clip can be made. A deleted placeholder is not written, so any order or repetition
 * of one upload's events lands the same document.
 * @param doc - The Timeline document.
 * @param event - The upload's event.
 * @returns How many placeholders the event concerned.
 * @throws {Error} When the Timeline content is missing, unsupported or structurally invalid.
 */
export function applyTimelineUpload(doc: Y.Doc, event: TimelineUploadEvent): number {
  const document = readTimelineDocument(doc);
  const placeholders = Object.values(document.clips)
    .flatMap((clip) => (clip.kind === "upload" && clip.upload.uploadId === event.uploadId ? [clip] : []))
    .sort((a, b) => compareTimelineIds(a.id, b.id));
  if (placeholders.length === 0) return 0;
  const write = writesFor(document, placeholders, event);
  if (write === undefined) return 0;
  doc.transact(() => write(doc.getMap<unknown>("clips"), doc), TIMELINE_UPLOAD_ORIGIN);
  return placeholders.length;
}
