// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Invariants of upload placeholders through edits, undo, redo and conversion (#1434 design §5, TDD-MANDATE).
 *
 * The Timeline document is on the Yjs collaboration critical path. For any interleaving of the user's edits, undo,
 * redo and the upload's conversion (`convertTimelineUpload`, as the controller runs it again whenever a placeholder of
 * the finished upload reappears):
 * - every clip record passes `TimelineClipSchema`;
 * - the conversion never changes a clip's track or start frame;
 * - after the conversion every converted clip is a video whose source is in the document and holds its range.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { TimelineClipSchema, type ProjectRegisteredAsset } from '@breatic/shared';

import { _resetForTests } from '@web/data/yjs/manager';
import { convertTimelineUpload, readTimelineDocument } from '@web/data/yjs/timeline-document';
import { evictTimelineEditSession, getTimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import type { TimelineEditCommand } from '@web/data/yjs/timeline-edit';
import { validateTimelineRange } from '@web/data/yjs/timeline-time';
import {
  FPS, MAIN, OFF, ON, V2, V3, cid, clip, idFactory, seededDoc, timeline, track,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { ASSET_ID, UPLOAD_ID, addUpload, clipRecords, registeredVideo, uploadClip } from '@web/data/yjs/__tests__/timeline-upload-fixtures';

const NAME = 'project-p/timeline-upload-property';

type Step =
  | { kind: 'move'; pick: number; start: number; toV3: boolean; magnet: boolean }
  | { kind: 'range'; pick: number; sourceIn: number; length: number }
  | { kind: 'split'; pick: number; at: number }
  | { kind: 'duplicate'; pick: number }
  | { kind: 'delete'; pick: number; magnet: boolean }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'convert' };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('move' as const), pick: fc.nat(), start: fc.integer({ min: 0, max: 200 }), toV3: fc.boolean(), magnet: fc.boolean() }),
  fc.record({ kind: fc.constant('range' as const), pick: fc.nat(), sourceIn: fc.integer({ min: 0, max: 130 }), length: fc.integer({ min: 1, max: 130 }) }),
  fc.record({ kind: fc.constant('split' as const), pick: fc.nat(), at: fc.integer({ min: 1, max: 120 }) }),
  fc.record({ kind: fc.constant('duplicate' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('delete' as const), pick: fc.nat(), magnet: fc.boolean() }),
  fc.constant({ kind: 'undo' as const }),
  fc.constant({ kind: 'redo' as const }),
  fc.constant({ kind: 'convert' as const }),
);

/**
 * The placement of every placeholder of the upload, by clip id.
 * @param doc - The document.
 * @returns Track and start of each placeholder.
 * @throws {never} Never.
 */
function placeholderPlacements(doc: Y.Doc): Map<string, { trackId: string; startFrame: number }> {
  const out = new Map<string, { trackId: string; startFrame: number }>();
  for (const [id, record] of Object.entries(clipRecords(doc))) {
    const value = record as { kind?: unknown; upload?: { uploadId?: unknown }; trackId?: unknown; startFrame?: unknown };
    if (value.kind === 'upload' && value.upload?.uploadId === UPLOAD_ID) out.set(id, { trackId: String(value.trackId), startFrame: Number(value.startFrame) });
  }
  return out;
}

/**
 * Assert every clip record passes the clip schema.
 * @param doc - The document.
 * @param after - What just ran, for the failure message.
 * @throws {Error} When a record is invalid.
 */
function expectRecordsValid(doc: Y.Doc, after: Step): void {
  for (const [id, record] of Object.entries(clipRecords(doc))) {
    expect(TimelineClipSchema.safeParse(record).success, `after ${JSON.stringify(after)}, clip ${id}: ${JSON.stringify(record)}`).toBe(true);
  }
}

afterEach(() => {
  evictTimelineEditSession(NAME);
  _resetForTests();
});

describe('upload placeholders under any interleaving (fast-check)', () => {
  it('keeps every record valid, and converts in place into videos inside their source', () => {
    const asset = fc.constantFrom<ProjectRegisteredAsset>(registeredVideo(1.5), registeredVideo(2.5), registeredVideo(5), registeredVideo(null));
    fc.assert(fc.property(asset, fc.array(step, { minLength: 1, maxLength: 14 }), (registered, steps) => {
      const doc = seededDoc(timeline([clip(cid(90), MAIN, 0, 48)], [track(MAIN, 0), track(V2, 1), track(V3, 2)]));
      const session = getTimelineEditSession(doc, NAME);
      const newId = idFactory('50000000');
      try {
        expect(session.edit(addUpload(uploadClip(cid(1), V2, 10), OFF)).ok).toBe(true);
        for (const next of steps) {
          const ids = [...doc.getMap('clips').keys()].sort();
          const target = 'pick' in next ? ids[next.pick % Math.max(1, ids.length)] : undefined;
          let command: TimelineEditCommand | null = null;
          if (next.kind === 'move' && target !== undefined) {
            command = { operation: 'move', parameters: { clipId: target, startFrame: next.start, trackId: next.toV3 ? V3 : V2 }, placement: next.magnet ? ON : OFF };
          } else if (next.kind === 'range' && target !== undefined) {
            const start = readTimelineDocument(doc).clips[target]?.startFrame ?? 0;
            command = { operation: 'set_range', parameters: { clipId: target, startFrame: start, sourceInFrame: next.sourceIn, durationFrames: next.length }, placement: OFF };
          } else if (next.kind === 'split' && target !== undefined) {
            const start = readTimelineDocument(doc).clips[target]?.startFrame ?? 0;
            command = { operation: 'split', parameters: { clipId: target, frame: start + next.at, newClipId: newId() }, placement: OFF };
          } else if (next.kind === 'duplicate' && target !== undefined) {
            command = { operation: 'duplicate', parameters: { clipId: target, newClipId: newId() }, placement: OFF };
          } else if (next.kind === 'delete' && target !== undefined) {
            command = { operation: 'delete', parameters: { clipId: target }, placement: next.magnet ? ON : OFF };
          }
          if (command !== null) session.edit(command);
          else if (next.kind === 'undo') session.undo();
          else if (next.kind === 'redo') session.redo();
          else if (next.kind === 'convert') {
            const before = placeholderPlacements(doc);
            convertTimelineUpload(doc, UPLOAD_ID, registered);
            expect(placeholderPlacements(doc).size).toBe(0);
            const read = readTimelineDocument(doc);
            for (const [id, placed] of before) {
              const converted = read.clips[id];
              if (converted === undefined) continue;
              expect(converted, `conversion moved clip ${id}`).toMatchObject({ kind: 'video', ...placed });
              if (converted.kind !== 'video') continue;
              const source = read.sources[converted.sourceId];
              expect(source, `converted clip ${id} has no source`).toMatchObject({ assetId: ASSET_ID });
              if (source !== undefined) expect(validateTimelineRange(converted, source, FPS), `converted clip ${id} reads past its source`).toBe(true);
            }
          }
          expectRecordsValid(doc, next);
        }
      } finally {
        evictTimelineEditSession(NAME);
        doc.destroy();
      }
    }), { numRuns: 150 });
  });
});
