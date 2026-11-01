// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";
import {
  TimelineDocumentV1Schema, TimelineEditCommandSchema, TimelineSettingsSchema, TimelineTrackSchema, TimelineVideoClipSchema,
  type TimelineDocumentV1, type TimelineEditCommand, type TimelineSettings,
} from "@shared/timeline/schema.js";
import { planTimelineEdit, type TimelineEditPlan } from "@shared/timeline/edit.js";
import { newId as createId } from "@shared/ids.js";

/**
 * Attach a child map before populating it, preserving Yjs field-level merges.
 * @param parent - The document's attached collection map.
 * @param id - The stable child identity.
 * @param value - Fields to place in the child.
 * @returns The attached child map.
 * @throws {Error} When Yjs cannot attach a map to this document.
 */
function attachRecord(parent: Y.Map<unknown>, id: string, value: object): Y.Map<unknown> {
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
function freezeRecord<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecord(child);
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
  const normalized = freezeRecord(TimelineSettingsSchema.parse(settings));
  doc.transact(() => {
    const timeline = doc.getMap("timeline");
    timeline.set("schemaVersion", 1);
    timeline.set("settings", normalized);
    attachRecord(doc.getMap("tracks"), "visual-1", { id: "visual-1", kind: "visual", order: 0 });
    doc.getMap("clips");
    doc.getMap("sources");
  });
}

/** Records left out of a read because they fail their schema, listed so a user can see and delete them. */
export interface TimelineDamagedRecords { clips: string[]; tracks: string[] }

/**
 * Keep the records of one collection that pass their schema.
 * @param collection - The collection as JSON.
 * @param schema - The record schema.
 * @param schema.safeParse - Validates one record.
 * @param damaged - Collects the ids of records that fail.
 * @returns The valid records by id.
 * @throws {never} Never.
 */
function validRecords(collection: Record<string, unknown>, schema: { safeParse: (value: unknown) => { success: boolean } }, damaged: string[]): Record<string, unknown> {
  const valid: Record<string, unknown> = {};
  for (const [id, record] of Object.entries(collection)) {
    if (schema.safeParse(record).success) valid[id] = record;
    else damaged.push(id);
  }
  return valid;
}

/**
 * Read our DTO without manufacturing initial state on the client; a damaged clip or track record is left out
 * and listed, so one bad record never closes the whole Timeline.
 * @param doc - The content document to project.
 * @returns The readable Timeline and the damaged record ids.
 * @throws {Error} When the content is empty, unsupported or its roots are structurally invalid.
 */
export function readTimelineContent(doc: Y.Doc): { document: TimelineDocumentV1; damaged: TimelineDamagedRecords } {
  if (!doc.share.has("timeline")) throw new Error("Timeline content has not been initialized");
  const timeline = doc.getMap("timeline");
  const damaged: TimelineDamagedRecords = { clips: [], tracks: [] };
  const document = TimelineDocumentV1Schema.parse({
    schemaVersion: timeline.get("schemaVersion"),
    settings: timeline.get("settings"),
    tracks: validRecords(doc.getMap("tracks").toJSON(), TimelineTrackSchema, damaged.tracks),
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

/**
 * Delete one clip or track record, damaged or not, in one transaction.
 * @param doc - The content document.
 * @param kind - The collection.
 * @param id - The record id.
 * @param origin - The transaction origin.
 * @throws {never} Never.
 */
export function removeTimelineRecord(doc: Y.Doc, kind: "clips" | "tracks", id: string, origin: unknown): void {
  doc.transact(() => { doc.getMap(kind).delete(id); }, origin);
}

/**
 * Apply a user-confirmed layout edit to the shared Y.Doc in one transaction, writing only what changed.
 * @param doc - The current content document.
 * @param command - The normalized edit with the editing user's placement switches.
 * @param origin - The transaction origin; a Y.UndoManager tracking it undoes this edit in one step.
 * @param newId - Supplies ids for clips cut by an overwrite and tracks created by a linkage bump.
 * @returns The applied plan, or why nothing was written.
 * @throws {Error} When the document or command is structurally invalid.
 */
export function applyTimelineEdit(doc: Y.Doc, command: TimelineEditCommand, origin: unknown, newId: () => string = createId): TimelineEditPlan {
  const normalized = TimelineEditCommandSchema.parse(command);
  const current = readTimelineDocument(doc);
  const plan = planTimelineEdit(current, normalized, newId);
  if (!plan.ok) return plan;
  const { next } = plan;
  doc.transact(() => {
    const sources = doc.getMap<unknown>("sources");
    for (const [id, source] of Object.entries(next.sources)) if (!sources.has(id)) sources.set(id, freezeRecord(structuredClone(source)));
    writeRecords(doc.getMap<unknown>("tracks"), current.tracks, next.tracks);
    writeRecords(doc.getMap<unknown>("clips"), current.clips, next.clips);
  }, origin);
  return plan;
}

/**
 * Bring one collection to its planned state: attach new records, delete removed ones, set only changed fields.
 * @param parent - The attached collection map.
 * @param before - The records the plan started from.
 * @param after - The planned records.
 * @throws {Error} When an existing record is not an attached map.
 */
function writeRecords(parent: Y.Map<unknown>, before: Readonly<Record<string, object>>, after: Readonly<Record<string, object>>): void {
  for (const id of Object.keys(before)) if (after[id] === undefined) parent.delete(id);
  for (const [id, value] of Object.entries(after)) {
    const was = before[id];
    if (was === undefined) {
      attachRecord(parent, id, value);
      continue;
    }
    const target = parent.get(id);
    if (!(target instanceof Y.Map)) throw new Error("Timeline record is not an attached map");
    for (const [key, item] of Object.entries(value)) {
      if (JSON.stringify((was as Record<string, unknown>)[key]) !== JSON.stringify(item)) target.set(key, item);
    }
  }
}
