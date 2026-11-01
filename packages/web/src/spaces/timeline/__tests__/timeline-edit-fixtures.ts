// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Valid Timeline fixtures for the web edit tests (inner#1708).
 *
 * The shared package keeps its own fixtures under `shared/src/timeline/__tests__`, which web tests cannot
 * import (they resolve `@breatic/shared` from its built `dist`). These mirror them. Every document goes through
 * `TimelineDocumentV1Schema`, so a fixture with a bad uuid or a non-conforming source fails here with a schema
 * error instead of masquerading as an edit refusal.
 */

import * as Y from 'yjs';
import {
  TimelineDocumentV1Schema,
  type TimelineDocumentV1, type TimelineRate, type TimelineTrack,
  type TimelineVideoClip, type TimelineVideoSource,
} from '@breatic/shared';
import type { TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import { initializeTimelineDocument } from '@breatic/shared/space-content';

export const FPS: TimelineRate = { num: 24, den: 1 };
export const SETTINGS = { width: 1920, height: 1080, fps: FPS };
export const MAIN = 'visual-1';

export const ON: TimelineEditPlacement = { magnet: true, linkage: true };
export const OFF: TimelineEditPlacement = { magnet: false, linkage: false };

/** 1000 frames at 24 fps. */
export const SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000001',
  kind: 'video',
  assetId: '20000000-0000-4000-8000-000000000001',
  timebase: FPS,
  extentFrames: 1000,
  durationSeconds: '41.666',
  durationOrigin: 'registered',
};

/** 48 frames at 24 fps. */
export const SHORT_SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000002',
  kind: 'video',
  assetId: '20000000-0000-4000-8000-000000000002',
  timebase: FPS,
  extentFrames: 48,
  durationSeconds: '2',
  durationOrigin: 'registered',
};

/**
 * A stable clip uuid whose code-unit order follows `n`.
 * @param n - The clip's ordinal.
 * @returns A valid uuid.
 * @throws {never} Never.
 */
export function cid(n: number): string {
  return `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * A uuid factory for the ids an edit creates, distinct from every fixture id.
 * @param prefix - The first uuid group, to tell factories apart.
 * @returns A function returning a new uuid on each call.
 * @throws {never} Never.
 */
export function idFactory(prefix = '40000000'): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-0000-4000-8000-${String(next).padStart(12, '0')}`;
  };
}

/**
 * A default full-frame clip of `SOURCE`.
 * @param id - The clip id.
 * @param trackId - Its track.
 * @param startFrame - Its timeline start.
 * @param durationFrames - Its length.
 * @param fields - Overrides such as `sourceInFrame` or `sourceId`.
 * @returns A schema-valid clip.
 * @throws {never} Never.
 */
export function clip(id: string, trackId: string, startFrame: number, durationFrames: number, fields: Partial<TimelineVideoClip> = {}): TimelineVideoClip {
  return {
    id, trackId, kind: 'video', sourceId: SOURCE.id, startFrame, sourceInFrame: 0, durationFrames,
    rate: { num: 1, den: 1 }, gain: 1, mute: false, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    ...fields,
  };
}

/**
 * A visual track.
 * @param id - The track id.
 * @param order - Its stacking order.
 * @returns The track.
 * @throws {never} Never.
 */
export function track(id: string, order: number): TimelineTrack {
  return { id, kind: 'visual', order };
}

/**
 * Build a schema-checked Timeline document.
 * @param clips - The clips to place.
 * @param tracks - The tracks, main and v2 by default.
 * @param sources - The sources, `SOURCE` and `SHORT_SOURCE` by default.
 * @returns The parsed document.
 * @throws {Error} When the fixture itself is invalid.
 */
export function timeline(
  clips: readonly TimelineVideoClip[],
  tracks: readonly TimelineTrack[] = [track(MAIN, 0), track('v2', 1)],
  sources: readonly TimelineVideoSource[] = [SOURCE, SHORT_SOURCE],
): TimelineDocumentV1 {
  return TimelineDocumentV1Schema.parse({
    schemaVersion: 1,
    settings: SETTINGS,
    tracks: Object.fromEntries(tracks.map((item) => [item.id, item])),
    clips: Object.fromEntries(clips.map((item) => [item.id, item])),
    sources: Object.fromEntries(sources.map((item) => [item.id, item])),
  });
}

/**
 * Attach a record map before setting its fields, as the production writer does.
 * @param parent - The collection map.
 * @param value - The record.
 * @param value.id - Its key.
 * @throws {Error} When Yjs cannot attach the map.
 */
function attach(parent: Y.Map<unknown>, value: { id: string }): void {
  const child = new Y.Map<unknown>();
  parent.set(value.id, child);
  for (const [key, item] of Object.entries(value)) child.set(key, item);
}

/**
 * A seeded Y.Doc holding `document`'s tracks, clips and sources, written by a setup origin no session tracks.
 * @param document - The layout to hold.
 * @returns The document.
 * @throws {Error} When the seed fails.
 */
export function seededDoc(document: TimelineDocumentV1 = timeline([])): Y.Doc {
  const doc = new Y.Doc();
  initializeTimelineDocument(doc, document.settings);
  doc.transact(() => {
    const tracks = doc.getMap<unknown>('tracks');
    for (const item of Object.values(document.tracks)) if (!tracks.has(item.id)) attach(tracks, item);
    const sources = doc.getMap<unknown>('sources');
    for (const item of Object.values(document.sources)) sources.set(item.id, item);
    const clips = doc.getMap<unknown>('clips');
    for (const item of Object.values(document.clips)) attach(clips, item);
  }, 'setup');
  return doc;
}

/**
 * Relay every update between two replicas, as a provider would.
 * @param left - One replica.
 * @param right - The other replica.
 * @throws {never} Never.
 */
export function connect(left: Y.Doc, right: Y.Doc): void {
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left), 'remote');
  Y.applyUpdate(left, Y.encodeStateAsUpdate(right), 'remote');
  left.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(right, update, 'remote'); });
  right.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(left, update, 'remote'); });
}

/**
 * The clips on one track as `[id, startFrame, durationFrames]`, by start then id.
 * @param document - The document to read.
 * @param trackId - The track.
 * @returns The ordered triples.
 * @throws {never} Never.
 */
export function starts(document: TimelineDocumentV1, trackId: string): Array<[string, number, number]> {
  return Object.values(document.clips)
    .filter((item) => item.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => [item.id, item.startFrame, item.durationFrames]);
}
