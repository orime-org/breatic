// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as Y from "yjs";
import type { z } from "zod";
import {
  TimelineClipSchema, TimelineDocumentV1Schema, TimelineOperationReceiptSchema, TimelineSettingsSchema, TimelineTrackSchema,
  TimelineVideoSourceSchema, TIMELINE_MAIN_TRACK_ID, type TimelineDocumentV1, type TimelineOperationReceipt, type TimelineSettings,
  type TimelineVideoSource,
} from "@shared/timeline/schema.js";
import { timelineLayerFrameOffset, type TimelineLayerFrame } from "@shared/timeline/layer-geometry.js";

/** The document version new code writes: clip offsets are fractions of the frame (#1502). */
const FRAME_OFFSET_VERSION = 2;

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
    timeline.set("schemaVersion", FRAME_OFFSET_VERSION);
    timeline.set("settings", normalized);
    attachTimelineRecord(doc.getMap("tracks"), TIMELINE_MAIN_TRACK_ID, { id: TIMELINE_MAIN_TRACK_ID, kind: "visual", order: 0 });
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
 * @param transform - A stored transform value.
 * @param frame - The document's frame size.
 * @param frame.width - Frame width in pixels.
 * @param frame.height - Frame height in pixels.
 * @returns The transform in the frame-offset format, or the value itself when it is not an object.
 * @throws {never} Never.
 */
function frameOffsetTransform(transform: unknown, frame: TimelineLayerFrame): unknown {
  if (transform === null || typeof transform !== "object") return transform;
  const { x, y, ...rest } = transform as Record<string, unknown>;
  if (!isPixelTransform(transform)) return "frameX" in rest || "frameY" in rest ? rest : transform;
  return { ...rest, ...timelineLayerFrameOffset(frame, { x: x as number, y: y as number }) };
}

/**
 * A stored clip record as JSON with its transform in the frame-offset format.
 * @param value - The stored clip value.
 * @param frame - The document's frame size, or undefined when the settings are unreadable.
 * @returns The record to validate.
 * @throws {never} Never.
 */
function frameOffsetClip(value: unknown, frame: TimelineLayerFrame | undefined): unknown {
  const json = timelineRecordJson(value);
  if (frame === undefined || json === null || typeof json !== "object" || !("transform" in json)) return json;
  return { ...json, transform: frameOffsetTransform(json.transform, frame) };
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
 * Every readable operation receipt, by action id. A document written before receipts existed has no such root and
 * reads as having none; the root is not created by reading.
 * @param doc - The content document.
 * @returns The receipts that pass their schema.
 * @throws {never} Never.
 */
function readOperationReceipts(doc: Y.Doc): Record<string, TimelineOperationReceipt> {
  const receipts: Record<string, TimelineOperationReceipt> = {};
  if (!doc.share.has("operationReceipts")) return receipts;
  doc.getMap("operationReceipts").forEach((value, actionId) => {
    const parsed = TimelineOperationReceiptSchema.safeParse(timelineRecordJson(value));
    if (parsed.success) receipts[actionId] = parsed.data;
  });
  return receipts;
}

/**
 * Read one stored source value, by the rule every Timeline record follows.
 * @param value - The value stored under `id` in the sources map.
 * @param id - Its key.
 * @returns The source, or undefined when the value is not a valid source stored under its own id.
 * @throws {never} Never.
 */
export function readTimelineSource(value: unknown, id: string): TimelineVideoSource | undefined {
  return readRecord(TimelineVideoSourceSchema, value, id);
}

/**
 * Read our DTO without manufacturing initial state on the client; a damaged clip, track or source record is left
 * out, and damaged clips are listed, so one bad record never closes the whole Timeline. Version 1 and 2 documents are
 * both read, and a clip stored with pixel offsets is read as frame offsets of the current frame (#1502).
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
    tracks: readRecords(doc.getMap("tracks"), TimelineTrackSchema),
    clips: readRecords(doc.getMap("clips"), TimelineClipSchema, damaged.clips, (value) => frameOffsetClip(value, frame.success ? frame.data : undefined)),
    sources: readRecords(doc.getMap("sources"), TimelineVideoSourceSchema),
    operationReceipts: readOperationReceipts(doc),
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
 * Whether a stored Timeline still needs the #1502 upgrade: it is version 1, or a clip holds pixel offsets (an old page
 * may write one after the upgrade). A document without Timeline content needs none, and checking creates no root.
 * @param doc - The content document.
 * @returns Whether `upgradeTimelineDocument` would write.
 * @throws {never} Never.
 */
export function timelineDocumentNeedsUpgrade(doc: Y.Doc): boolean {
  if (!doc.share.has("timeline")) return false;
  if (doc.getMap("timeline").get("schemaVersion") === 1) return true;
  return pixelClips(doc).length > 0;
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
 * Store every pixel-offset clip as frame offsets of the current frame and mark a version 1 document as version 2, in
 * one transaction under the caller's origin. Nothing moves on screen: the stored values equal what reading returned.
 * A version 2 document without pixel clips is left untouched.
 * @param doc - The content document.
 * @returns How many clips were converted.
 * @throws {never} Never.
 */
export function upgradeTimelineDocument(doc: Y.Doc): number {
  if (!timelineDocumentNeedsUpgrade(doc)) return 0;
  const timeline = doc.getMap("timeline");
  const frame = TimelineSettingsSchema.safeParse(timeline.get("settings"));
  const clips = frame.success ? pixelClips(doc) : [];
  doc.transact(() => {
    if (frame.success) {
      for (const { id, value, transform } of clips) {
        const converted = frameOffsetTransform(transform, frame.data);
        if (value instanceof Y.Map) value.set("transform", converted);
        else doc.getMap("clips").set(id, { ...(timelineRecordJson(value) as object), transform: converted });
      }
    }
    if (timeline.get("schemaVersion") !== FRAME_OFFSET_VERSION) timeline.set("schemaVersion", FRAME_OFFSET_VERSION);
  });
  return clips.length;
}
