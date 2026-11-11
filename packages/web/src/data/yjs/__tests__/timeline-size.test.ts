// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec section
 * 7: the Timeline writes. Edits go through the personal edit session
 * (`getTimelineEditSession(doc, name).edit`), the production caller of
 * `applyTimelineEdit`; a refused edit answers `{ ok: false, reason }` and
 * `writeSpaceDoc` shows its toast once (spec answer Q12). A delete on a full
 * Space is planned with the magnet off and writes only deletions (`remove`);
 * one whose plan writes anything else is `compound` (answer Q13).
 *
 * Initial layout: main-track clips c1 (0-100), c2 (100-200), c3 (200-300)
 * naming sources s1, s2, s3; clip a2 on track v2 is attached to c2 and goes
 * with it. Magnet and linkage are on. Content arrives as a peer's update.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TimelineEditModule from '@web/data/yjs/timeline-edit';
import * as Y from 'yjs';
import { type TimelineVideoSource } from '@breatic/shared';
import { updateShape } from '@breatic/shared/update-shape';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({ toast, muteToasts: vi.fn(), _unmuteToastsForTests: vi.fn() }));
vi.mock('@web/data/yjs/timeline-edit', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineEditModule>();
  return { ...actual, planTimelineEdit: vi.fn(actual.planTimelineEdit) };
});

import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { readTimelineDocument, removeTimelineClip } from '@web/data/yjs/timeline-document';
import { planTimelineEdit, type TimelineEditCommand, type TimelineEditPlan } from '@web/data/yjs/timeline-edit';
import { evictTimelineEditSession, getTimelineEditSession, type TimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import {
  MAIN, ON, SOURCE, V2, cid, clip, seededDoc, timeline, track,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  P_WARNING, SIZE_COPY_EN, captureWrite, enterSize, expectKindShape, expectSizeToast, kindRows, pushSize, type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const NAME = docName.timelineSpace('p1', 't1');
const V3 = 'v3';
const C1 = cid(1);
const C2 = cid(2);
const C3 = cid(3);
const C4 = cid(4);
const A2 = cid(12);
const SPLIT = cid(21);
const COPY = cid(22);

/**
 * A source distinct from the fixture's by its last id digits.
 * @param n - Its ordinal.
 * @returns The source.
 */
function source(n: number): TimelineVideoSource {
  return { ...SOURCE, id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`, assetId: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}` };
}

const S1 = source(1);
const S2 = source(2);
const S3 = source(3);
const S4 = source(4);

/** The test's open document and session. */
let doc: Y.Doc;
let session: TimelineEditSession;

/**
 * Loads the initial layout into the registered document as a peer's update
 * and opens the session on it.
 * @param plainC1 - Store c1 as a plain value instead of a map.
 * @returns The document.
 */
function seed(plainC1 = false): Y.Doc {
  const layout = timeline(
    [
      clip(C1, MAIN, 0, 100, { sourceId: S1.id }),
      clip(C2, MAIN, 100, 100, { sourceId: S2.id }),
      clip(C3, MAIN, 200, 100, { sourceId: S3.id }),
      clip(A2, V2, 120, 20, { sourceId: S2.id }),
    ],
    [track(MAIN, 0), track(V2, 1), track(V3, 2)],
    [S1, S2, S3],
  );
  const source = seededDoc(layout);
  if (plainC1) source.transact(() => { source.getMap('clips').set(C1, layout.clips[C1]); }, 'setup');
  doc = getDoc(NAME);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source), 'remote');
  source.destroy();
  session = getTimelineEditSession(doc, NAME);
  return doc;
}

/**
 * One edit command with the magnet and linkage on.
 * @param operation - The operation.
 * @param parameters - Its parameters.
 * @returns The command.
 */
function command(operation: TimelineEditCommand['operation'], parameters: Record<string, unknown>): TimelineEditCommand {
  return { operation, parameters, placement: ON } as TimelineEditCommand;
}

/**
 * The refusal reason `session.edit` answers in a state (answer Q12).
 * @param code - The state.
 * @returns The reason.
 */
function reasonIn(code: SizeCode): 'full' | 'over_ceiling' | 'resyncing' {
  return code === 'Z' ? 'resyncing' : code === 'O' || code === 'CEIL' ? 'over_ceiling' : 'full';
}

/**
 * Asserts a refused edit's answer.
 * @param plan - What `session.edit` returned.
 * @param _doc - The document.
 * @param code - The state.
 */
function refusedPlan(plan: TimelineEditPlan, _doc: Y.Doc, code: SizeCode): void {
  expect(plan).toEqual({ ok: false, reason: reasonIn(code) });
}

/**
 * The clip and track records as JSON.
 * @param target - The document.
 * @returns The records.
 */
function records(target: Y.Doc): { clips: Record<string, unknown>; tracks: Record<string, unknown>; sources: string[] } {
  return { clips: target.getMap('clips').toJSON(), tracks: target.getMap('tracks').toJSON(), sources: [...target.getMap('sources').keys()].sort() };
}

const actualPlan = (await vi.importActual<typeof TimelineEditModule>('@web/data/yjs/timeline-edit')).planTimelineEdit;

afterEach(() => {
  vi.mocked(planTimelineEdit).mockImplementation(actualPlan);
  evictTimelineEditSession(NAME);
  clearAllDocSizes();
  _resetForTests();
  vi.clearAllMocks();
});

describe('TL-01 commands that write a new clip record are add', () => {
  kindRows<TimelineEditPlan>({
    id: 'TL-01', title: 'add_video', kind: 'add', name: NAME, seed: () => seed(),
    run: () => session.edit(command('add_video', { source: S4, clip: clip(C4, MAIN, 300, 100, { sourceId: S4.id }) })),
    written: (plan, target) => { expect(plan.ok).toBe(true); expect(target.getMap('clips').has(C4)).toBe(true); },
    refused: refusedPlan,
  });
  kindRows<TimelineEditPlan>({
    id: 'TL-01', title: 'split', kind: 'add', name: NAME, seed: () => seed(),
    run: () => session.edit(command('split', { clipId: C1, frame: 50, newClipId: SPLIT })),
    written: (plan, target) => { expect(plan.ok).toBe(true); expect(target.getMap('clips').has(SPLIT)).toBe(true); },
    refused: refusedPlan,
  });
  kindRows<TimelineEditPlan>({
    id: 'TL-01', title: 'duplicate', kind: 'add', name: NAME, seed: () => seed(),
    run: () => session.edit(command('duplicate', { clipId: C3, newClipId: COPY })),
    written: (plan, target) => { expect(plan.ok).toBe(true); expect(target.getMap('clips').has(COPY)).toBe(true); },
    refused: refusedPlan,
  });
});

describe('TL-02 commands that change existing clip records are edit', () => {
  kindRows<TimelineEditPlan>({
    id: 'TL-02', title: 'move c3', kind: 'edit', name: NAME, seed: () => seed(),
    run: () => session.edit(command('move', { clipId: C3, startFrame: 0 })),
    written: (plan) => { expect(plan.ok).toBe(true); },
    refused: refusedPlan,
  });
  kindRows<TimelineEditPlan>({
    id: 'TL-02', title: 'set_range c1', kind: 'edit', name: NAME, seed: () => seed(),
    run: () => session.edit(command('set_range', { clipId: C1, startFrame: 0, sourceInFrame: 10, durationFrames: 50 })),
    written: (plan) => { expect(plan.ok).toBe(true); },
    refused: refusedPlan,
  });
});

describe('TL-03 deleting below the limit packs and sweeps as before', () => {
  it('TL-03 at U delete c2 moves c3 up and drops s2', () => {
    seed();
    const plan = session.edit(command('delete', { clipId: C2 }));
    expect(plan.ok).toBe(true);
    const after = readTimelineDocument(doc);
    expect(after.clips[C3]?.startFrame).toBe(100);
    expect(after.clips[C2]).toBeUndefined();
    expect(after.clips[A2]).toBeUndefined();
    expect(doc.getMap('sources').has(S2.id)).toBe(false);
  });
});

describe('TL-04 deleting on a full Space only deletes: no packing, no sweep', () => {
  it.each(['F', 'O'] as const)('TL-04 at %s delete c2 removes c2 and a2 and leaves everything else', (code) => {
    seed();
    const before = records(doc);
    enterSize(NAME, code);
    toast.warning.mockClear();
    const captured = captureWrite(doc, () => session.edit(command('delete', { clipId: C2 })));
    expect(captured.result.ok).toBe(true);
    const after = records(doc);
    expect(after.clips[C2]).toBeUndefined();
    expect(after.clips[A2]).toBeUndefined();
    expect(after.clips[C1]).toEqual(before.clips[C1]);
    expect(after.clips[C3]).toEqual(before.clips[C3]);
    expect(after.tracks).toEqual(before.tracks);
    expect(after.sources).toEqual(before.sources);
    expect(captured.shape).toBe('R');
    expectSizeToast(null);
  });
});

describe('TL-05 delete_track is planned: only deletions are remove, anything else compound', () => {
  it.each(['F', 'O'] as const)('TL-05 at %s deleting the empty track v3 is remove and goes through', (code) => {
    seed();
    enterSize(NAME, code);
    toast.warning.mockClear();
    const captured = captureWrite(doc, () => session.edit(command('delete_track', { trackId: V3 })));
    expect(captured.result.ok).toBe(true);
    expect(doc.getMap('tracks').has(V3)).toBe(false);
    expectKindShape('remove', captured);
    expectSizeToast(null);
  });

  // The real planner, magnet off, writes only deletions for `delete` and
  // `delete_track` (a track must be empty to be deleted), so the plan that also
  // rewrites another record is made by wrapping it: the delete also sets c3's gain.
  it('TL-05 at F a delete whose plan also changes another record is compound: refused with the compound toast', () => {
    vi.mocked(planTimelineEdit).mockImplementation((current, cmd, newId) => {
      const plan = actualPlan(current, cmd, newId);
      if (!plan.ok || cmd.operation !== 'delete') return plan;
      const c3 = plan.next.clips[C3];
      return { ...plan, next: { ...plan.next, clips: { ...plan.next.clips, [C3]: { ...c3, gain: 0.5 } } } };
    });
    seed();
    enterSize(NAME, 'F');
    toast.warning.mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    const captured = captureWrite(doc, () => session.edit(command('delete', { clipId: C2 })));
    expect(captured.result).toEqual({ ok: false, reason: 'full' });
    expect(captured.shape).toBe('∅');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expectSizeToast(SIZE_COPY_EN.T_COMPOUND);
  });

  it('TL-05 at U the same delete writes the deletion and the change, a compound shape', () => {
    vi.mocked(planTimelineEdit).mockImplementation((current, cmd, newId) => {
      const plan = actualPlan(current, cmd, newId);
      if (!plan.ok || cmd.operation !== 'delete') return plan;
      const c3 = plan.next.clips[C3];
      return { ...plan, next: { ...plan.next, clips: { ...plan.next.clips, [C3]: { ...c3, gain: 0.5 } } } };
    });
    seed();
    const captured = captureWrite(doc, () => session.edit(command('delete', { clipId: C2 })));
    expect(captured.result.ok).toBe(true);
    expectKindShape('compound', captured);
  });
});

describe('TL-06 removeTimelineClip on a full Space only deletes the clip', () => {
  it.each(['F', 'O'] as const)('TL-06 at %s removes c3 and keeps s3', (code) => {
    seed();
    enterSize(NAME, code);
    toast.warning.mockClear();
    const captured = captureWrite(doc, () => removeTimelineClip(doc, C3, session.origin));
    expect(doc.getMap('clips').has(C3)).toBe(false);
    expect(doc.getMap('sources').has(S3.id)).toBe(true);
    expect(captured.shape).toBe('R');
    expectSizeToast(null);
  });

  it('TL-06 at U removes c3 and sweeps s3 as before', () => {
    seed();
    removeTimelineClip(doc, C3, session.origin);
    expect(doc.getMap('clips').has(C3)).toBe(false);
    expect(doc.getMap('sources').has(S3.id)).toBe(false);
  });

  it('TL-06 at Z writes nothing and shows no toast', () => {
    seed();
    enterSize(NAME, 'Z');
    toast.warning.mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    const captured = captureWrite(doc, () => removeTimelineClip(doc, C3, session.origin));
    expect(captured.shape).toBe('∅');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expectSizeToast(null);
  });
});

describe('TL-07 a clip stored as a plain value is deleted as a whole map entry', () => {
  it.each(['F', 'O'] as const)('TL-07 at %s deleting plain c1 removes the entry', (code) => {
    seed(true);
    expect(doc.getMap('clips').get(C1)).not.toBeInstanceOf(Y.Map);
    enterSize(NAME, code);
    toast.warning.mockClear();
    const captured = captureWrite(doc, () => session.edit(command('delete', { clipId: C1 })));
    expect(captured.result.ok).toBe(true);
    expect(doc.getMap('clips').has(C1)).toBe(false);
    expect(captured.shape).toBe('R');
    expectSizeToast(null);
  });
});

describe('TL-08 converting a plain record before an edit is edit', () => {
  it('TL-08 at U the conversion transaction sends a structural update', () => {
    seed(true);
    const mirror = new Y.Doc({ gc: false });
    Y.applyUpdate(mirror, Y.encodeStateAsUpdate(doc));
    const conversions: Uint8Array[] = [];
    /**
     * Keeps the format conversion's local updates.
     * @param update - The update.
     * @param origin - Its origin.
     * @param _doc - The document.
     * @param transaction - The transaction.
     */
    const onUpdate = (update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction): void => {
      if (transaction.local && typeof origin === 'symbol' && origin.description === 'timeline-record-format') conversions.push(update);
    };
    doc.on('update', onUpdate);
    const plan = session.edit(command('move', { clipId: C1, startFrame: 250 }));
    doc.off('update', onUpdate);
    expect(plan.ok).toBe(true);
    expect(conversions.length).toBeGreaterThan(0);
    expect(doc.getMap('clips').get(C1)).toBeInstanceOf(Y.Map);
    // Classified against the structure before the edit (`mirror` was taken then).
    const update = Y.mergeUpdates(conversions);
    const shape = updateShape(update, mirror.store);
    expectKindShape('edit', { shape: shape.pureDelete ? (shape.wholeTypesOnly ? 'R' : 'D') : 'S', update });
  });

  it('TL-08 at F a move of plain c1 is refused whole: neither the conversion nor the edit is written', () => {
    seed(true);
    enterSize(NAME, 'F');
    toast.warning.mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    const captured = captureWrite(doc, () => session.edit(command('move', { clipId: C1, startFrame: 250 })));
    expect(captured.result).toEqual({ ok: false, reason: 'full' });
    expect(captured.shape).toBe('∅');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getMap('clips').get(C1)).not.toBeInstanceOf(Y.Map);
    expectSizeToast(SIZE_COPY_EN.T_ADD);
  });
});

describe('TL-09 sources a full Space left behind are swept by the next normal edit', () => {
  it('TL-09 after TL-04, back at warning, moving c1 drops s2', () => {
    seed();
    enterSize(NAME, 'F');
    expect(session.edit(command('delete', { clipId: C2 })).ok).toBe(true);
    expect(doc.getMap('sources').has(S2.id)).toBe(true);
    pushSize(NAME, P_WARNING);
    expect(session.edit(command('move', { clipId: C1, startFrame: 250 })).ok).toBe(true);
    expect(doc.getMap('sources').has(S2.id)).toBe(false);
  });
});

/**
 * Removes s1 on a peer and delivers that as a remote update.
 * @param target - The document.
 */
function peerDropsS1(target: Y.Doc): void {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(target));
  const vector = Y.encodeStateVector(target);
  peer.getMap('sources').delete(S1.id);
  Y.applyUpdate(target, Y.encodeStateAsUpdate(peer, vector), 'remote');
  peer.destroy();
}

describe('TL-10 the session does not write back missing sources while the Space is full or resyncing', () => {
  it.each(['F', 'O', 'Z'] as const)('TL-10 at %s a peer removing s1 is not followed by a local write', (code) => {
    seed();
    session.setCanWrite(true);
    enterSize(NAME, code);
    toast.warning.mockClear();
    const captured = captureWrite(doc, () => peerDropsS1(doc));
    expect(doc.getMap('sources').has(S1.id)).toBe(false);
    expect(captured.shape).toBe('∅');
    expectSizeToast(null);
  });
});

describe('TL-11 back below the limit, the next transaction writes the source back', () => {
  it('TL-11 after TL-10 and a warning push, a peer update brings s1 back', () => {
    seed();
    session.setCanWrite(true);
    enterSize(NAME, 'F');
    peerDropsS1(doc);
    expect(doc.getMap('sources').has(S1.id)).toBe(false);
    pushSize(NAME, P_WARNING);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const vector = Y.encodeStateVector(doc);
    (peer.getMap('clips').get(C3) as Y.Map<unknown>).set('gain', 0.5);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, vector), 'remote');
    peer.destroy();
    expect(doc.getMap('sources').has(S1.id)).toBe(true);
  });
});
