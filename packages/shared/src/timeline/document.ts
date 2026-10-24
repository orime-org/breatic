// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";
import {
  NativeEditRecordSchema, TimelineDocumentV1Schema, TimelineEditCommandSchema, TimelineSettingsSchema,
  type NativeEditRecord, type TimelineDocumentV1, type TimelineEditCommand, type TimelineSettings,
  type TimelineVideoClip, type TimelineVideoSource,
} from "@shared/timeline/schema.js";
import { resolveTimelineArrangement } from "@shared/timeline/arrangement.js";
import { validateTimelineRange } from "@shared/timeline/time.js";

const EDIT_ORIGIN = Symbol("timeline-native-edit");

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
  if (Y.decodeUpdate(Y.encodeStateAsUpdate(doc)).structs.length > 0) throw new Error("Timeline initialization requires empty content");
  const normalized = freezeRecord(TimelineSettingsSchema.parse(settings));
  doc.transact(() => {
    const timeline = doc.getMap("timeline");
    timeline.set("schemaVersion", 1);
    timeline.set("settings", normalized);
    attachRecord(doc.getMap("tracks"), "visual-1", { id: "visual-1", kind: "visual", order: 0 });
    doc.getMap("clips");
    doc.getMap("sources");
    doc.getMap("nativeEdits");
  });
}

/**
 * Read our DTO without manufacturing initial state on the client.
 * @param doc - The content document to project.
 * @returns The current Timeline format.
 * @throws {Error} When the content is empty, unsupported or structurally invalid.
 */
export function readTimelineDocument(doc: Y.Doc): TimelineDocumentV1 {
  if (!doc.share.has("timeline")) throw new Error("Timeline content has not been initialized");
  const timeline = doc.getMap("timeline");
  return TimelineDocumentV1Schema.parse({
    schemaVersion: timeline.get("schemaVersion"),
    settings: timeline.get("settings"),
    tracks: doc.getMap("tracks").toJSON(),
    clips: doc.getMap("clips").toJSON(),
    sources: doc.getMap("sources").toJSON(),
    nativeEdits: doc.getMap("nativeEdits").toJSON(),
  });
}

/**
 * Prepare one canonical edit against the complete current arrangement.
 * @param doc - The current content document.
 * @param command - The normalized edit to prepare.
 * @returns Its target and either an applicable clip/source or a stable reason.
 * @throws {Error} When the current document or command is invalid.
 */
function prepareEdit(doc: Y.Doc, command: TimelineEditCommand): {
  clipId: string;
  clip?: TimelineVideoClip;
  source?: TimelineVideoSource;
  reason?: NativeEditRecord["notAppliedReason"];
} {
  const current = readTimelineDocument(doc);
  const clipId = command.operation === "add_video" ? command.parameters.clip.id : command.parameters.clipId;
  const existing = current.clips[clipId];
  if (command.operation === "set_start" && existing === undefined) return { clipId, reason: "target_missing" };
  const clip = command.operation === "add_video"
    ? command.parameters.clip
    : existing === undefined ? undefined : { ...existing, startFrame: command.parameters.startFrame };
  if (clip === undefined) return { clipId, reason: "target_missing" };
  const source = command.operation === "add_video" ? command.parameters.source : current.sources[clip.sourceId];
  if (source === undefined) return { clipId, reason: "source_unavailable" };
  if (!validateTimelineRange(clip, source, current.settings.fps).valid) return { clipId, reason: "invalid_range" };
  const arrangement = resolveTimelineArrangement({
    tracks: Object.values(current.tracks),
    clips: [...Object.values(current.clips).filter((item) => item.id !== clipId), clip],
  });
  const placement = arrangement.placements.find((item) => item.clipId === clipId);
  if (placement?.status !== "ready") return { clipId, reason: placement?.reasons.some((reason) => reason.code === "overlap") ? "overlap" : "target_missing" };
  return { clipId, clip, source };
}

/**
 * Record one native effect together with its layout in a Yjs transaction.
 * @param doc - The current content document.
 * @param command - The user-confirmed edit with its stable action id.
 * @returns The original immutable record when the action is replayed.
 * @throws {Error} When the document or command is structurally invalid.
 */
export function applyTimelineEdit(doc: Y.Doc, command: TimelineEditCommand): NativeEditRecord {
  const normalized = TimelineEditCommandSchema.parse(command);
  const edits = doc.getMap<unknown>("nativeEdits");
  const existing = edits.get(normalized.actionId);
  if (existing !== undefined) return freezeRecord(NativeEditRecordSchema.parse(existing));
  const prepared = prepareEdit(doc, normalized);
  const record = freezeRecord(NativeEditRecordSchema.parse({
    version: 1,
    ...normalized,
    effect: prepared.reason === undefined ? "applied" : "not_applied",
    targetClipIds: [prepared.clipId],
    ...(prepared.reason !== undefined && { notAppliedReason: prepared.reason }),
  }));
  doc.transact(() => {
    if (prepared.clip !== undefined && prepared.source !== undefined && prepared.reason === undefined) {
      const clips = doc.getMap<unknown>("clips");
      if (normalized.operation === "add_video") {
        if (!doc.getMap("sources").has(prepared.source.id)) doc.getMap("sources").set(prepared.source.id, freezeRecord(prepared.source));
        attachRecord(clips, prepared.clip.id, prepared.clip);
      } else {
        const clip = clips.get(prepared.clip.id);
        if (!(clip instanceof Y.Map)) throw new Error("Timeline clip is not an attached map");
        clip.set("startFrame", prepared.clip.startFrame);
      }
    }
    edits.set(normalized.actionId, record);
  }, EDIT_ORIGIN);
  return record;
}
