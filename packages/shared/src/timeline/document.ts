// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as Y from "yjs";
import type { z } from "zod";
import {
  TimelineClipSchema, TimelineDocumentV1Schema, TimelineOperationReceiptSchema, TimelineSettingsSchema, TimelineTrackSchema,
  TimelineVideoSourceSchema, TIMELINE_MAIN_TRACK_ID, type TimelineDocumentV1, type TimelineOperationReceipt, type TimelineSettings,
  type TimelineVideoSource,
} from "@shared/timeline/schema.js";

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
    timeline.set("schemaVersion", 1);
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
 * Read one stored record: a Y type is read as JSON, and the record counts only when it passes its schema and is
 * stored under its own id. A peer may store any Yjs content under any key.
 * @param schema - The record schema.
 * @param value - The stored value.
 * @param id - Its key.
 * @returns The record, or undefined when it is not readable.
 * @throws {never} Never.
 */
function readRecord<T extends { id: string }>(schema: z.ZodType<T>, value: unknown, id: string): T | undefined {
  const parsed = schema.safeParse(timelineRecordJson(value));
  return parsed.success && parsed.data.id === id ? parsed.data : undefined;
}

/**
 * Every readable record of one collection, by id.
 * @param collection - The collection map.
 * @param schema - The record schema.
 * @param damaged - Collects the keys of unreadable records, when given.
 * @returns The readable records.
 * @throws {never} Never.
 */
function readRecords<T extends { id: string }>(collection: Y.Map<unknown>, schema: z.ZodType<T>, damaged?: string[]): Record<string, T> {
  const valid: Record<string, T> = {};
  collection.forEach((value, id) => {
    const record = readRecord(schema, value, id);
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
 * out, and damaged clips are listed, so one bad record never closes the whole Timeline.
 * @param doc - The content document to project.
 * @returns The readable Timeline and the damaged record ids.
 * @throws {Error} When the content is empty, unsupported or its roots are structurally invalid.
 */
export function readTimelineContent(doc: Y.Doc): { document: TimelineDocumentV1; damaged: TimelineDamagedRecords } {
  if (!doc.share.has("timeline")) throw new Error("Timeline content has not been initialized");
  const timeline = doc.getMap("timeline");
  const damaged: TimelineDamagedRecords = { clips: [] };
  const document = TimelineDocumentV1Schema.parse({
    schemaVersion: timeline.get("schemaVersion"),
    settings: timeline.get("settings"),
    tracks: readRecords(doc.getMap("tracks"), TimelineTrackSchema),
    clips: readRecords(doc.getMap("clips"), TimelineClipSchema, damaged.clips),
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
