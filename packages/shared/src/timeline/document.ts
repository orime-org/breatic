// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as Y from "yjs";
import type { z } from "zod";
import {
  TimelineClipSchema, TimelineDocumentV1Schema, TimelineSettingsSchema, TimelineSourceSchema, TimelineTrackSchema,
  TIMELINE_MAIN_TRACK_ID, type TimelineDocumentV1, type TimelineSettings, type TimelineSource,
} from "@shared/timeline/schema.js";

/**
 * The document version new code writes: clip offsets are fractions of the frame (#1502), tracks have no kind and
 * placeholders name their kind (inner#1709).
 */
const CURRENT_VERSION = 3;

/** A frame size in pixels. */
type TimelineFrame = Pick<TimelineSettings, "width" | "height">;

/**
 * Attach a child map before populating it, preserving Yjs field-level merges.
 * @param parent - The document's attached collection map.
 * @param id - The stable child identity.
 * @param value - Fields to place in the child.
 * @returns The attached child map.
 * @throws {Error} When Yjs cannot attach a map to this document.
 */
export function attachTimelineRecord(parent: Y.Map<unknown>, id: string, value: object): Y.Map<unknown> {
  const child = new Y.Map<unknown>();
  parent.set(id, child);
  for (const [key, item] of Object.entries(value)) child.set(key, item);
  return child;
}

/**
 * Freeze a normalized JSON value before sharing it with callers and Yjs.
 * @param value - The normalized record or one of its children.
 * @returns The same deeply immutable value.
 * @throws {never} Never.
 */
export function freezeTimelineRecord<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTimelineRecord(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Seed a new server-owned Timeline document.
 * @param doc - The empty server-owned document.
 * @param settings - The configured creation parameters.
 * @throws {Error} When nonempty content would be overwritten or settings are invalid.
 */
export function initializeTimelineDocument(doc: Y.Doc, settings: TimelineSettings): void {
  const held = Y.decodeUpdate(Y.encodeStateAsUpdate(doc));
  if (held.structs.length !== 0 || held.ds.clients.size !== 0) throw new Error("Timeline initialization requires empty content");
  const normalized = freezeTimelineRecord(TimelineSettingsSchema.parse(settings));
  doc.transact(() => {
    const timeline = doc.getMap("timeline");
    timeline.set("schemaVersion", CURRENT_VERSION);
    timeline.set("settings", normalized);
    attachTimelineRecord(doc.getMap("tracks"), TIMELINE_MAIN_TRACK_ID, { id: TIMELINE_MAIN_TRACK_ID, order: 0 });
    doc.getMap("clips");
    doc.getMap("sources");
  });
}

/** Clip records left out of a read because they fail their schema, listed for the user to delete. */
export interface TimelineDamagedRecords { clips: string[] }

/**
 * A stored Timeline value as JSON, the one reading every record, reference and media lookup uses.
 * @param value - A value stored in a Timeline map; a peer may store any Yjs content.
 * @returns The JSON of a Y type, or the value itself.
 * @throws {never} Never.
 */
export function timelineRecordJson(value: unknown): unknown {
  return value instanceof Y.AbstractType ? value.toJSON() : value;
}

/**
 * Whether a stored transform is in the pixel format before #1502: `x` and `y` without `frameX` and `frameY`.
 * @param transform - A stored transform value.
 * @returns Whether it carries only pixel offsets.
 * @throws {never} Never.
 */
function isPixelTransform(transform: unknown): transform is Record<string, unknown> & { x: number; y: number } {
  if (transform === null || typeof transform !== "object") return false;
  const fields = transform as Record<string, unknown>;
  return typeof fields.x === "number" && typeof fields.y === "number" && !("frameX" in fields) && !("frameY" in fields);
}

/**
 * A stored transform in the frame-offset format: pixel offsets are divided by the frame size, and pixel fields beside
 * frame fields are dropped. Reading and storing use this one conversion, so storing a converted clip moves nothing.
 * Version 1 stored `x` and `y` in pixels of the frame, so the division is that format's definition. It is written here
 * so the layer geometry stays in the main entry's own module, which web's entry chunk carries for the lazy layer
 * handles (verify:chunks).
 * @param transform - A stored transform value.
 * @param frame - The document's frame size.
 * @param frame.width - Frame width in pixels.
 * @param frame.height - Frame height in pixels.
 * @returns The transform in the frame-offset format, or the value itself when it is not an object.
 * @throws {never} Never.
 */
function frameOffsetTransform(transform: unknown, frame: TimelineFrame): unknown {
  if (transform === null || typeof transform !== "object") return transform;
  const { x, y, ...rest } = transform as Record<string, unknown>;
  if (!isPixelTransform(transform)) return "frameX" in rest || "frameY" in rest ? rest : transform;
  return { ...rest, frameX: (x as number) / frame.width, frameY: (y as number) / frame.height };
}

/**
 * Whether a stored clip is a placeholder written before version 3, whose `upload` does not name its kind.
 * @param json - The stored clip as JSON.
 * @returns Whether it is such a placeholder.
 * @throws {never} Never.
 */
function isKindlessPlaceholder(json: unknown): json is { upload: Record<string, unknown> } {
  if (json === null || typeof json !== "object") return false;
  const { kind, upload } = json as { kind?: unknown; upload?: unknown };
  return kind === "upload" && upload !== null && typeof upload === "object" && !("kind" in upload);
}

/**
 * A landed clip as its kind defines it (inner#1709 design §4.3). Collab turns a placeholder into a clip in place
 * while members may write that same record, and Yjs keeps one value per key, so a merge can leave the placeholder's
 * `upload`, or a trimmed video or sound placeholder's in-point on an image; the conversion's own result drops both.
 * @param json - The stored clip as JSON.
 * @returns The record to validate.
 * @throws {never} Never.
 */
function landedClip(json: unknown): unknown {
  if (json === null || typeof json !== "object" || !("kind" in json) || json.kind === "upload") return json;
  const { upload: _upload, ...rest } = json as Record<string, unknown>;
  return json.kind === "image" ? { ...rest, sourceInFrame: 0 } : rest;
}

/**
 * A stored clip record as JSON in the current format: its transform in frame offsets, and a placeholder written before
 * version 3 naming the video it was then the only kind of. Reading and upgrading use this one conversion.
 * @param value - The stored clip value.
 * @param frame - The document's frame size, or undefined when the settings are unreadable.
 * @returns The record to validate.
 * @throws {never} Never.
 */
function currentClip(value: unknown, frame: TimelineFrame | undefined): unknown {
  let json = timelineRecordJson(value);
  if (isKindlessPlaceholder(json)) json = { ...json, upload: { ...json.upload, kind: "video" } };
  json = landedClip(json);
  if (frame === undefined || json === null || typeof json !== "object" || !("transform" in json)) return json;
  return { ...json, transform: frameOffsetTransform(json.transform, frame) };
}

/**
 * Whether a stored track record still carries the kind tracks had before version 3.
 * @param json - The stored track as JSON.
 * @returns Whether it carries a kind.
 * @throws {never} Never.
 */
function hasTrackKind(json: unknown): json is Record<string, unknown> {
  return json !== null && typeof json === "object" && "kind" in json;
}

/**
 * A stored track record as JSON without the kind tracks had before version 3.
 * @param value - The stored track value.
 * @returns The record to validate.
 * @throws {never} Never.
 */
function currentTrack(value: unknown): unknown {
  const json = timelineRecordJson(value);
  if (!hasTrackKind(json)) return json;
  const { kind: _kind, ...rest } = json;
  return rest;
}

/**
 * Read one stored record: a Y type is read as JSON, and the record counts only when it passes its schema and is
 * stored under its own id. A peer may store any Yjs content under any key.
 * @param schema - The record schema.
 * @param value - The stored value.
 * @param id - Its key.
 * @param json - How the stored value becomes the JSON to validate.
 * @returns The record, or undefined when it is not readable.
 * @throws {never} Never.
 */
function readRecord<T extends { id: string }>(schema: z.ZodType<T>, value: unknown, id: string, json: (stored: unknown) => unknown = timelineRecordJson): T | undefined {
  const parsed = schema.safeParse(json(value));
  return parsed.success && parsed.data.id === id ? parsed.data : undefined;
}

/**
 * Every readable record of one collection, by id.
 * @param collection - The collection map.
 * @param schema - The record schema.
 * @param damaged - Collects the keys of unreadable records, when given.
 * @param json - How a stored value becomes the JSON to validate.
 * @returns The readable records.
 * @throws {never} Never.
 */
function readRecords<T extends { id: string }>(
  collection: Y.Map<unknown>, schema: z.ZodType<T>, damaged?: string[], json?: (stored: unknown) => unknown,
): Record<string, T> {
  const valid: Record<string, T> = {};
  collection.forEach((value, id) => {
    const record = readRecord(schema, value, id, json);
    if (record !== undefined) valid[id] = record;
    else damaged?.push(id);
  });
  return valid;
}

/**
 * Read one stored source value, by the rule every Timeline record follows.
 * @param value - The value stored under `id` in the sources map.
 * @param id - Its key.
 * @returns The source, or undefined when the value is not a valid source stored under its own id.
 * @throws {never} Never.
 */
export function readTimelineSource(value: unknown, id: string): TimelineSource | undefined {
  return readRecord(TimelineSourceSchema, value, id);
}

/**
 * Read our DTO without manufacturing initial state on the client; a damaged clip, track or source record is left
 * out, and damaged clips are listed, so one bad record never closes the whole Timeline. Version 1, 2 and 3 documents
 * are all read: a clip stored with pixel offsets is read as frame offsets of the current frame (#1502), a track's
 * stored kind is dropped and a placeholder without `upload.kind` is read as a video one (inner#1709).
 * @param doc - The content document to project.
 * @returns The readable Timeline and the damaged record ids.
 * @throws {Error} When the content is empty, unsupported or its roots are structurally invalid.
 */
export function readTimelineContent(doc: Y.Doc): { document: TimelineDocumentV1; damaged: TimelineDamagedRecords } {
  if (!doc.share.has("timeline")) throw new Error("Timeline content has not been initialized");
  const timeline = doc.getMap("timeline");
  const damaged: TimelineDamagedRecords = { clips: [] };
  const settings = timeline.get("settings");
  const frame = TimelineSettingsSchema.safeParse(settings);
  const document = TimelineDocumentV1Schema.parse({
    schemaVersion: timeline.get("schemaVersion"),
    settings,
    tracks: readRecords(doc.getMap("tracks"), TimelineTrackSchema, undefined, currentTrack),
    clips: readRecords(doc.getMap("clips"), TimelineClipSchema, damaged.clips, (value) => currentClip(value, frame.success ? frame.data : undefined)),
    sources: readRecords(doc.getMap("sources"), TimelineSourceSchema),
  });
  return { document, damaged };
}

/**
 * Read our DTO without manufacturing initial state on the client.
 * @param doc - The content document to project.
 * @returns The readable Timeline; damaged clip, track and source records are left out.
 * @throws {Error} When the content is empty, unsupported or its roots are structurally invalid.
 */
export function readTimelineDocument(doc: Y.Doc): TimelineDocumentV1 {
  return readTimelineContent(doc).document;
}

/**
 * Whether a stored Timeline still needs an upgrade: it is version 1 or 2, a clip holds pixel offsets (#1502), a track
 * carries a kind or a placeholder does not name its kind (inner#1709); an old page may write any of these after the
 * upgrade. A document without Timeline content needs none, and checking creates no root.
 * @param doc - The content document.
 * @returns Whether `upgradeTimelineDocument` would write.
 * @throws {never} Never.
 */
export function timelineDocumentNeedsUpgrade(doc: Y.Doc): boolean {
  if (!doc.share.has("timeline")) return false;
  const version = doc.getMap("timeline").get("schemaVersion");
  if (version === 1 || version === 2) return true;
  return pixelClips(doc).length > 0 || kindlessPlaceholders(doc).length > 0 || kindedTracks(doc).length > 0;
}

/**
 * The stored clips whose transform holds pixel offsets.
 * @param doc - The content document.
 * @returns Each such clip's id, stored value and transform.
 * @throws {never} Never.
 */
function pixelClips(doc: Y.Doc): { id: string; value: unknown; transform: unknown }[] {
  if (!doc.share.has("clips")) return [];
  const found: { id: string; value: unknown; transform: unknown }[] = [];
  doc.getMap("clips").forEach((value, id) => {
    const transform = value instanceof Y.Map ? value.get("transform") : (timelineRecordJson(value) as { transform?: unknown } | null)?.transform;
    if (isPixelTransform(transform)) found.push({ id, value, transform });
  });
  return found;
}

/**
 * The ids of the stored placeholders that do not name their kind.
 * @param doc - The content document.
 * @returns Their ids.
 * @throws {never} Never.
 */
function kindlessPlaceholders(doc: Y.Doc): string[] {
  if (!doc.share.has("clips")) return [];
  const found: string[] = [];
  doc.getMap("clips").forEach((value, id) => {
    if (isKindlessPlaceholder(timelineRecordJson(value))) found.push(id);
  });
  return found;
}

/**
 * The ids of the stored tracks that carry a kind.
 * @param doc - The content document.
 * @returns Their ids.
 * @throws {never} Never.
 */
function kindedTracks(doc: Y.Doc): string[] {
  if (!doc.share.has("tracks")) return [];
  const found: string[] = [];
  doc.getMap("tracks").forEach((value, id) => {
    if (hasTrackKind(timelineRecordJson(value))) found.push(id);
  });
  return found;
}

/**
 * Bring a stored Timeline to version 3 in one transaction under the caller's origin: every pixel-offset clip is stored
 * as frame offsets of the current frame, every placeholder without a kind names video, every track loses its kind, and
 * the version becomes 3. Nothing moves on screen: the stored values equal what reading returned. A version 3 document
 * holding none of these is left untouched.
 * @param doc - The content document.
 * @returns How many pixel-offset clips were converted.
 * @throws {never} Never.
 */
export function upgradeTimelineDocument(doc: Y.Doc): number {
  if (!timelineDocumentNeedsUpgrade(doc)) return 0;
  const timeline = doc.getMap("timeline");
  const frame = TimelineSettingsSchema.safeParse(timeline.get("settings"));
  const clips = frame.success ? pixelClips(doc) : [];
  doc.transact(() => {
    const clipMap = doc.getMap("clips");
    if (frame.success) {
      for (const { id, value, transform } of clips) {
        const converted = frameOffsetTransform(transform, frame.data);
        if (value instanceof Y.Map) value.set("transform", converted);
        else clipMap.set(id, { ...(timelineRecordJson(value) as object), transform: converted });
      }
    }
    for (const id of kindlessPlaceholders(doc)) {
      const value = clipMap.get(id);
      const json = timelineRecordJson(value) as { upload: Record<string, unknown> };
      const upload = { ...json.upload, kind: "video" };
      if (value instanceof Y.Map) value.set("upload", upload);
      else clipMap.set(id, { ...json, upload });
    }
    const trackMap = doc.getMap("tracks");
    for (const id of kindedTracks(doc)) {
      const value = trackMap.get(id);
      if (value instanceof Y.Map) value.delete("kind");
      else trackMap.set(id, currentTrack(value));
    }
    if (timeline.get("schemaVersion") !== CURRENT_VERSION) timeline.set("schemaVersion", CURRENT_VERSION);
  });
  return clips.length;
}

/**
 * The source id a clip record names, read from the raw record so a damaged record still counts as a reference.
 * @param record - A value of the clips map, or its JSON.
 * @returns Its string `sourceId`, if any.
 * @throws {never} Never.
 */
export function timelineClipSourceId(record: unknown): string | undefined {
  const json = timelineRecordJson(record);
  const id = typeof json === "object" && json !== null ? (json as { sourceId?: unknown }).sourceId : undefined;
  return typeof id === "string" ? id : undefined;
}

/**
 * The source ids the clip records name, damaged records included.
 * @param doc - The content document.
 * @returns The referenced source ids.
 * @throws {never} Never.
 */
function referencedSourceIds(doc: Y.Doc): Set<string> {
  const referenced = new Set<string>();
  doc.getMap<unknown>("clips").forEach((record) => {
    const id = timelineClipSourceId(record);
    if (id !== undefined) referenced.add(id);
  });
  return referenced;
}

/**
 * The referenced sources that `sources` lacks or holds unreadable and `values` holds.
 * @param sources - The sources map.
 * @param referenced - The referenced source ids.
 * @param values - Source values by id that this writer may write.
 * @returns Their ids.
 * @throws {never} Never.
 */
function missingSourceIds(sources: Y.Map<unknown>, referenced: Iterable<string>, values: Readonly<Record<string, TimelineSource>>): string[] {
  // Own keys only: a damaged clip may name any string, including an Object.prototype property.
  return [...referenced].filter((id) => readTimelineSource(sources.get(id), id) === undefined && Object.hasOwn(values, id));
}

/**
 * The referenced sources, damaged clip records included, that `sources` lacks or holds unreadable and `values` holds.
 * @param doc - The content document.
 * @param values - Source values by id that this writer may write.
 * @returns Their ids.
 * @throws {never} Never.
 */
export function missingTimelineSourceIds(doc: Y.Doc, values: Readonly<Record<string, TimelineSource>>): string[] {
  return missingSourceIds(doc.getMap<unknown>("sources"), referencedSourceIds(doc), values);
}

/**
 * Write referenced sources inside the caller's transaction: the ones in `reset` even when present, and any that is
 * missing, each from `values` when it holds it. Concurrent writes to one key keep only one of them, so a fresh
 * write narrows the window in which a peer's removal leaves a reference without its source; writing back a missing
 * one closes it.
 * @param doc - The content document.
 * @param values - Source values by id that this writer may write.
 * @param reset - Ids of sources a reference was just created or revived for.
 * @returns The referenced source ids.
 * @throws {never} Never.
 */
export function restoreTimelineSources(doc: Y.Doc, values: Readonly<Record<string, TimelineSource>>, reset: Iterable<string>): Set<string> {
  const sources = doc.getMap<unknown>("sources");
  const referenced = referencedSourceIds(doc);
  /**
   * Write one source value from `values`.
   * @param id - The source id.
   * @throws {never} Never.
   */
  const write = (id: string): void => {
    if (Object.hasOwn(values, id)) sources.set(id, freezeTimelineRecord(structuredClone(values[id])));
  };
  for (const id of new Set(reset)) if (referenced.has(id)) write(id);
  for (const id of missingSourceIds(sources, referenced, values)) write(id);
  return referenced;
}

/**
 * Bring `sources` to exactly the sources the clip records name, inside the caller's transaction.
 * @param doc - The content document.
 * @param values - Source values by id that this writer may write.
 * @param reset - Ids of sources a reference was just created or revived for.
 * @throws {never} Never.
 */
export function reconcileTimelineSources(doc: Y.Doc, values: Readonly<Record<string, TimelineSource>>, reset: Iterable<string>): void {
  const referenced = restoreTimelineSources(doc, values, reset);
  const sources = doc.getMap<unknown>("sources");
  for (const id of [...sources.keys()]) if (!referenced.has(id)) sources.delete(id);
}
