// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { durationToFrames } from '@breatic/shared';
import { TimelineEditCommandSchema } from '@web/data/yjs/timeline-edit';
import { initializeTimelineDocument } from '@breatic/shared/space-content';
import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import type {
  ProjectRegisteredAsset,
  TimelineSettings,
  TimelineTrack,
  TimelineVideoClip,
} from '@breatic/shared';
import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';

import { prepareTimelineMediaPlacement } from '@web/spaces/timeline/prepare-media-placement';

type PlacementInput = Parameters<typeof prepareTimelineMediaPlacement>[1];
type PlacementResult = ReturnType<typeof prepareTimelineMediaPlacement>;

const SETTINGS: TimelineSettings = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const SOURCE_ID = '10000000-0000-4000-8000-000000000001';
const CLIP_ID = '30000000-0000-4000-8000-000000000001';
const OTHER_SOURCE_ID = '10000000-0000-4000-8000-000000000002';
const OTHER_CLIP_ID = '30000000-0000-4000-8000-000000000002';
const ASSET: ProjectRegisteredAsset = {
  assetId: '20000000-0000-4000-8000-000000000001',
  projectReferenceId: '50000000-0000-4000-8000-000000000001',
  displayName: 'Product demo.mp4',
  kind: 'video',
  fileUrl: 'https://cdn.example/registered-demo.mp4',
  coverUrl: 'https://cdn.example/registered-demo-cover.jpg',
  width: 1280,
  height: 720,
  durationSeconds: 2,
  mimeType: 'video/mp4',
  sizeBytes: 8192,
};
const OFF: TimelineEditPlacement = { magnet: false, linkage: false };
const ON: TimelineEditPlacement = { magnet: true, linkage: true };
const docs: Y.Doc[] = [];

/**
 * Seed a real Timeline with explicitly fixed creation parameters.
 * @param settings - The parameters persisted before the client opens this Space.
 * @returns The tracked document.
 * @throws {Error} When shared initialization rejects the seed.
 */
function seededDoc(settings: TimelineSettings = SETTINGS): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  initializeTimelineDocument(doc, settings);
  return doc;
}

/**
 * Capture the immutable draft target and its currently resolved registered asset.
 * @param overrides - The individual boundary exercised by a case.
 * @returns A complete input using stable native identities.
 * @throws {never} Never.
 */
function placementInput(overrides: Partial<PlacementInput> = {}): PlacementInput {
  return {
    asset: { ...ASSET }, trackId: 'visual-1', startFrame: 72,
    clipId: CLIP_ID, sourceId: SOURCE_ID, canWrite: true, placement: OFF,
    ...overrides,
  };
}

/**
 * Observe preparation without permitting layout, source or draft mutation.
 * @param doc - The complete current collaborative document.
 * @param input - The captured draft that must survive both success and failure.
 * @returns The actual production preparation result.
 * @throws {Error} When preparation throws or an invariant assertion fails.
 */
function prepareUnchanged(doc: Y.Doc, input: PlacementInput): PlacementResult {
  const beforeBytes = Y.encodeStateAsUpdate(doc);
  const beforeState = readTimelineDocument(doc);
  const beforeInput = structuredClone(input);
  const result = prepareTimelineMediaPlacement(doc, input);
  expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeBytes);
  expect(readTimelineDocument(doc)).toEqual(beforeState);
  expect(input).toEqual(beforeInput);
  // Compare only the command or refusal; a success may carry more (for example the planned preview).
  return result.ok ? { ok: true, command: result.command } : { ok: false, reason: result.reason };
}

/**
 * Construct the independently specified default command for a two-second asset.
 * @param overrides - Placement fields changed by the test fixture.
 * @param placement - The editing user's switches carried by the command.
 * @returns The complete native add command with no playback URL in its source.
 * @throws {never} Never.
 */
function expectedCommand(overrides: Partial<TimelineVideoClip> = {}, placement: TimelineEditPlacement = OFF): Extract<TimelineEditCommand, { operation: 'add_video' }> {
  return {
    operation: 'add_video',
    parameters: {
      source: {
        id: SOURCE_ID, kind: 'video', assetId: ASSET.assetId, timebase: SETTINGS.fps,
        extentFrames: 48, durationSeconds: '2', durationOrigin: 'registered',
      },
      clip: {
        id: CLIP_ID, trackId: 'visual-1', kind: 'video', sourceId: SOURCE_ID,
        startFrame: 72, sourceInFrame: 0, durationFrames: 48,
        rate: { num: 1, den: 1 }, gain: 1, mute: false,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        ...overrides,
      },
    },
    placement,
  };
}

/**
 * Add a fixture clip through the real native write boundary.
 * @param doc - The seeded document at the default frame rate.
 * @param startFrame - The existing clip's integer placement.
 * @returns The complete existing command for later preservation assertions.
 * @throws {Error} When the shared edit boundary rejects this fixture.
 */
function occupy(doc: Y.Doc, startFrame: number): Extract<TimelineEditCommand, { operation: 'add_video' }> {
  const base = expectedCommand();
  const command: Extract<TimelineEditCommand, { operation: 'add_video' }> = {
    ...base,
    parameters: {
      source: { ...base.parameters.source, id: OTHER_SOURCE_ID },
      clip: { ...base.parameters.clip, id: OTHER_CLIP_ID, sourceId: OTHER_SOURCE_ID, startFrame },
    },
  };
  expect(applyTimelineEdit(doc, command, 'setup').ok).toBe(true);
  expect(readTimelineDocument(doc).clips[OTHER_CLIP_ID]).toEqual(command.parameters.clip);
  expect(readTimelineDocument(doc).sources[OTHER_SOURCE_ID]).toEqual(command.parameters.source);
  return command;
}

/**
 * Attach a real additional track before setting its fields.
 * @param doc - The document owning this test-only additional track.
 * @param track - The persisted track identity and compatibility kind.
 * @returns Nothing.
 * @throws {Error} When Yjs cannot attach the map.
 */
function addTrack(doc: Y.Doc, track: TimelineTrack): void {
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    doc.getMap('tracks').set(track.id, map);
    for (const [key, value] of Object.entries(track)) map.set(key, value);
  });
}

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

/**
 * Prepare a placement the applied edit refuses, then apply it (inner#1708 P5, R5).
 * @param doc - The collaborative document.
 * @param input - The captured draft.
 * @param reason - The refusal the applied edit reports.
 * @throws {Error} When preparation refuses it or the applied edit writes or reports otherwise.
 */
function refusedOnApply(doc: Y.Doc, input: PlacementInput, reason: string): void {
  const result = prepareUnchanged(doc, input);
  expect(result.ok, 'preparation only builds the command').toBe(true);
  if (!result.ok) return;
  const before = Y.encodeStateAsUpdate(doc);
  expect(applyTimelineEdit(doc, result.command, 'local')).toEqual({ ok: false, reason });
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
}

describe('prepareTimelineMediaPlacement', () => {
  it('prepares the complete default command without writing until native apply', () => {
    const doc = seededDoc();
    const result = prepareUnchanged(doc, placementInput());
    const command = expectedCommand();
    expect(result).toEqual({ ok: true, command });
    expect(readTimelineDocument(doc)).toEqual({
      schemaVersion: 1, settings: SETTINGS,
      tracks: { 'visual-1': { id: 'visual-1', kind: 'visual', order: 0 } },
      clips: {}, sources: {}, operationReceipts: {},
    });
    if (!result.ok) throw new Error('Expected a prepared native command');
    expect(TimelineEditCommandSchema.parse(result.command)).toEqual(command);
    expect(applyTimelineEdit(doc, result.command, 'local').ok).toBe(true);
    expect(readTimelineDocument(doc)).toEqual({
      schemaVersion: 1, settings: SETTINGS,
      tracks: { 'visual-1': { id: 'visual-1', kind: 'visual', order: 0 } },
      clips: { [CLIP_ID]: command.parameters.clip },
      sources: { [SOURCE_ID]: command.parameters.source },
      operationReceipts: {},
    });
  });

  it.each([
    { seconds: 2.01, fps: SETTINGS.fps, extent: 49 },
    { seconds: 0.14, fps: { num: 100, den: 1 }, extent: 14 },
    { seconds: 1.001, fps: { num: 30000, den: 1001 }, extent: 30 },
    { seconds: 1e-7, fps: SETTINGS.fps, extent: 1 },
  ])('conforms registered $seconds seconds at $fps to exactly $extent frames', ({ seconds, fps, extent }) => {
    const doc = seededDoc({ ...SETTINGS, fps });
    const result = prepareUnchanged(doc, placementInput({ asset: { ...ASSET, durationSeconds: seconds }, decodedDurationSeconds: 99 }));
    const base = expectedCommand();
    expect(durationToFrames(seconds, fps)).toBe(extent);
    expect(result).toEqual({ ok: true, command: {
      ...base,
      parameters: {
        source: { ...base.parameters.source, timebase: fps, extentFrames: extent, durationSeconds: String(seconds) },
        clip: { ...base.parameters.clip, durationFrames: extent },
      },
    } });
  });

  it.each([2.01, 1e-7])('uses measured decoded seconds %s only when registered duration is null', (seconds) => {
    const fps = { num: 30000, den: 1001 };
    const doc = seededDoc({ ...SETTINGS, fps });
    const base = expectedCommand();
    const extent = seconds === 2.01 ? 61 : 1;
    expect(prepareUnchanged(doc, placementInput({ asset: { ...ASSET, durationSeconds: null }, decodedDurationSeconds: seconds }))).toEqual({
      ok: true,
      command: {
        ...base,
        parameters: {
          source: { ...base.parameters.source, timebase: fps, extentFrames: extent, durationSeconds: String(seconds), durationOrigin: 'decoded' },
          clip: { ...base.parameters.clip, durationFrames: extent },
        },
      },
    });
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'ignores unusable decoded duration %s when registered duration is available',
    (decodedDurationSeconds) => {
      expect(prepareUnchanged(seededDoc(), placementInput({ decodedDurationSeconds }))).toEqual({
        ok: true, command: expectedCommand(),
      });
    },
  );

  it('refuses a read-only connection without changing the collaborative document', () => {
    expect(prepareUnchanged(seededDoc(), placementInput({ canWrite: false }))).toEqual({ ok: false, reason: 'readonly' });
  });

  it('refuses an unavailable Project asset even when decoded duration is available', () => {
    expect(prepareUnchanged(seededDoc(), placementInput({ asset: null, decodedDurationSeconds: 2 }))).toEqual({ ok: false, reason: 'source_unavailable' });
  });

  it.each(['image', 'audio', 'file'] as const)('does not place a registered %s as video', (kind) => {
    expect(prepareUnchanged(seededDoc(), placementInput({ asset: { ...ASSET, kind } }))).toEqual({ ok: false, reason: 'source_unavailable' });
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'keeps the draft when registered duration is null and decoded duration is %s',
    (decodedDurationSeconds) => {
      const input = placementInput({ asset: { ...ASSET, durationSeconds: null }, ...(decodedDurationSeconds !== undefined && { decodedDurationSeconds }) });
      expect(prepareUnchanged(seededDoc(), input)).toEqual({ ok: false, reason: 'metadata_unavailable' });
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'does not replace invalid non-null registered duration %s with decoded duration',
    (durationSeconds) => {
      const input = placementInput({ asset: { ...ASSET, durationSeconds }, decodedDurationSeconds: 2 });
      expect(prepareUnchanged(seededDoc(), input)).toEqual({ ok: false, reason: 'metadata_unavailable' });
    },
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'builds a command at frame %s and leaves its refusal to the applied edit (inner#1708 R5)',
    (startFrame) => {
      refusedOnApply(seededDoc(), placementInput({ startFrame }), 'invalid_range');
    },
  );

  it.each(['', 'x'.repeat(65)])('builds a command for the malformed track id %j and leaves its refusal to the applied edit (inner#1708 R5)', (trackId) => {
    refusedOnApply(seededDoc(), placementInput({ trackId }), 'invalid_range');
  });

  it('leaves a placement whose end overflows safe frames to the planner', () => {
    refusedOnApply(seededDoc(), placementInput({ startFrame: Number.MAX_SAFE_INTEGER }), 'invalid_range');
  });

  it('allows a clip whose exclusive end is exactly the largest safe frame', () => {
    const startFrame = Number.MAX_SAFE_INTEGER - 48;
    expect(prepareUnchanged(seededDoc(), placementInput({ startFrame }))).toEqual({ ok: true, command: expectedCommand({ startFrame }) });
  });

  it('refuses a finite duration whose conformed extent cannot fit safe frames', () => {
    expect(prepareUnchanged(seededDoc(), placementInput({ asset: { ...ASSET, durationSeconds: Number.MAX_VALUE } }))).toEqual({ ok: false, reason: 'invalid_range' });
  });

  it('reports a missing target track without recreating it', () => {
    const doc = seededDoc();
    doc.getMap('tracks').delete('visual-1');
    refusedOnApply(doc, placementInput(), 'track_missing');
    expect(readTimelineDocument(doc).tracks).toEqual({});
  });

  it('reports a sub track a peer removed after the draft captured it', () => {
    const doc = seededDoc();
    addTrack(doc, { id: 'visual-2', kind: 'visual', order: 1 });
    const draft = placementInput({ trackId: 'visual-2' });
    doc.getMap('tracks').delete('visual-2');
    refusedOnApply(doc, draft, 'track_missing');
  });

  it('refuses an audio track rather than choosing a different visual track', () => {
    const doc = seededDoc();
    addTrack(doc, { id: 'audio-1', kind: 'audio', order: 1 });
    refusedOnApply(doc, placementInput({ trackId: 'audio-1' }), 'track_missing');
  });

  it('never overwrites an existing clip with a reused clip identity', () => {
    const doc = seededDoc();
    const existing = occupy(doc, 0);
    refusedOnApply(doc, placementInput({ clipId: OTHER_CLIP_ID }), 'id_taken');
    expect(readTimelineDocument(doc).clips).toEqual({ [OTHER_CLIP_ID]: existing.parameters.clip });
  });

  it('carries the editing user\'s placement switches in the command', () => {
    expect(prepareUnchanged(seededDoc(), placementInput({ placement: ON }))).toEqual({ ok: true, command: expectedCommand({}, ON) });
  });

  it('places onto a new visual track when the draft asks for one', () => {
    const doc = seededDoc();
    const base = expectedCommand();
    const result = prepareUnchanged(doc, placementInput({ newTrackId: 'track-new' }));
    expect(result).toEqual({ ok: true, command: { ...base, parameters: { ...base.parameters, newTrackId: 'track-new' } } });
    if (!result.ok) throw new Error('Expected a prepared command');
    expect(applyTimelineEdit(doc, result.command, 'local').ok).toBe(true);
    expect(readTimelineDocument(doc).tracks['track-new']).toEqual({ id: 'track-new', kind: 'visual', order: 1 });
    expect(readTimelineDocument(doc).clips[CLIP_ID]?.trackId).toBe('track-new');
  });

  it('refuses a new track id that is already taken', () => {
    const doc = seededDoc();
    addTrack(doc, { id: 'visual-2', kind: 'visual', order: 1 });
    refusedOnApply(doc, placementInput({ newTrackId: 'visual-2' }), 'id_taken');
  });

  it.each([0, 1, 47, 48, 95, 96])('accepts a sub-track placement at frame %s over an existing clip as an overwrite', (startFrame) => {
    const doc = seededDoc();
    addTrack(doc, { id: 'visual-2', kind: 'visual', order: 1 });
    const base = occupy(doc, 0);
    expect(applyTimelineEdit(doc, { operation: 'move', parameters: { clipId: OTHER_CLIP_ID, startFrame: 48, trackId: 'visual-2' }, placement: OFF }, 'setup').ok).toBe(true);
    const result = prepareUnchanged(doc, placementInput({ trackId: 'visual-2', startFrame }));
    expect(result).toEqual({ ok: true, command: expectedCommand({ trackId: 'visual-2', startFrame }) });
    if (!result.ok) throw new Error('Expected a prepared command');
    expect(applyTimelineEdit(doc, result.command, 'local').ok).toBe(true);
    const after = readTimelineDocument(doc);
    expect(after.clips[CLIP_ID]).toMatchObject({ trackId: 'visual-2', startFrame, durationFrames: 48 });
    // The covered clip's source stays only while a clip still references it (inner#1708 L2).
    const stillReferenced = Object.values(after.clips).some((item) => item.kind === 'video' && item.sourceId === OTHER_SOURCE_ID);
    expect(after.sources[OTHER_SOURCE_ID] ?? null).toEqual(stillReferenced ? base.parameters.source : null);
    const covered = Object.values(after.clips).filter((item) => item.trackId === 'visual-2' && item.id !== CLIP_ID)
      .filter((item) => item.startFrame < startFrame + 48 && startFrame < item.startFrame + item.durationFrames);
    expect(covered).toEqual([]);
  });

  it('inserts onto the magnetic main track instead of refusing an overlap', () => {
    const doc = seededDoc();
    occupy(doc, 0);
    const result = prepareUnchanged(doc, placementInput({ startFrame: 12, placement: ON }));
    expect(result).toEqual({ ok: true, command: expectedCommand({ startFrame: 12 }, ON) });
    if (!result.ok) throw new Error('Expected a prepared command');
    expect(applyTimelineEdit(doc, result.command, 'local').ok).toBe(true);
    const main = Object.values(readTimelineDocument(doc).clips).sort((a, b) => a.startFrame - b.startFrame);
    expect(main.map((item) => [item.id, item.startFrame])).toEqual([[CLIP_ID, 0], [OTHER_CLIP_ID, 48]]);
  });

  it('allows simultaneous video placements on different visual tracks', () => {
    const doc = seededDoc();
    occupy(doc, 72);
    addTrack(doc, { id: 'visual-2', kind: 'visual', order: 1 });
    expect(prepareUnchanged(doc, placementInput({ trackId: 'visual-2' }))).toEqual({
      ok: true, command: expectedCommand({ trackId: 'visual-2' }),
    });
  });

  it.each([120, 96])('keeps the original upload draft target after another clip moves to %s', (movedStart) => {
    const doc = seededDoc();
    addTrack(doc, { id: 'visual-2', kind: 'visual', order: 1 });
    const draft = placementInput({ asset: null, trackId: 'visual-2', startFrame: 72 });
    occupy(doc, 0);
    expect(applyTimelineEdit(doc, { operation: 'move', parameters: { clipId: OTHER_CLIP_ID, startFrame: movedStart, trackId: 'visual-2' }, placement: OFF }, 'peer').ok).toBe(true);
    const completedUpload = { ...draft, asset: { ...ASSET } };
    expect(prepareUnchanged(doc, completedUpload)).toEqual({ ok: true, command: expectedCommand({ trackId: 'visual-2', startFrame: 72 }) });
    expect(completedUpload.trackId).toBe('visual-2');
    expect(completedUpload.startFrame).toBe(72);
    expect(readTimelineDocument(doc).clips[OTHER_CLIP_ID]?.startFrame).toBe(movedStart);
  });

  it('preserves integer-frame targets and every still-referenced source across generated sub-track placements', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: -48, max: 48 }),
      (baseFrame, offset) => {
        const doc = seededDoc();
        addTrack(doc, { id: 'visual-2', kind: 'visual', order: 1 });
        const occupiedStart = baseFrame + 48;
        const existing = occupy(doc, 0);
        expect(applyTimelineEdit(doc, { operation: 'move', parameters: { clipId: OTHER_CLIP_ID, startFrame: occupiedStart, trackId: 'visual-2' }, placement: OFF }, 'setup').ok).toBe(true);
        const startFrame = occupiedStart + offset;
        const result = prepareUnchanged(doc, placementInput({ trackId: 'visual-2', startFrame }));
        expect(result).toEqual({ ok: true, command: expectedCommand({ trackId: 'visual-2', startFrame }) });
        if (!result.ok) throw new Error('Expected a prepared placement');
        expect(applyTimelineEdit(doc, result.command, 'local').ok).toBe(true);
        expect(readTimelineDocument(doc).clips[CLIP_ID]).toEqual(expectedCommand({ trackId: 'visual-2', startFrame }).parameters.clip);
        const after = readTimelineDocument(doc);
        const stillReferenced = Object.values(after.clips).some((item) => item.kind === 'video' && item.sourceId === OTHER_SOURCE_ID);
        expect(after.sources[OTHER_SOURCE_ID] ?? null).toEqual(stillReferenced ? existing.parameters.source : null);
      },
    ));
  });
});
