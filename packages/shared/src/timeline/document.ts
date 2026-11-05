// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";
import {
  TimelineDocumentV1Schema, TimelineSettingsSchema, TimelineTrackSchema, TimelineVideoClipSchema,
  TIMELINE_MAIN_TRACK_ID, type TimelineDocumentV1, type TimelineSettings,
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
 * Keep the records of one collection that pass their schema.
 * @param collection - The collection as JSON.
 * @param schema - The record schema.
 * @param schema.safeParse - Validates one record.
 * @param damaged - Collects the ids of records that fail, when given.
 * @returns The valid records by id.
 * @throws {never} Never.
 */
function validRecords(collection: Record<string, unknown>, schema: { safeParse: (value: unknown) => { success: boolean } }, damaged?: string[]): Record<string, unknown> {
  const valid: Record<string, unknown> = {};
  for (const [id, record] of Object.entries(collection)) {
    if (schema.safeParse(record).success) valid[id] = record;
    else damaged?.push(id);
  }
  return valid;
}

/**
 * Read our DTO without manufacturing initial state on the client; a damaged clip or track record is left out, and
 * damaged clips are listed, so one bad record never closes the whole Timeline.
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
    tracks: validRecords(doc.getMap("tracks").toJSON(), TimelineTrackSchema),
    clips: validRecords(doc.getMap("clips").toJSON(), TimelineVideoClipSchema, damaged.clips),
    sources: doc.getMap("sources").toJSON(),
  });
  return { document, damaged };
}

/**
 * Read our DTO without manufacturing initial state on the client.
 * @param doc - The content document to project.
 * @returns The readable Timeline; damaged clip and track records are left out.
 * @throws {Error} When the content is empty, unsupported or its roots are structurally invalid.
 */
export function readTimelineDocument(doc: Y.Doc): TimelineDocumentV1 {
  return readTimelineContent(doc).document;
}
