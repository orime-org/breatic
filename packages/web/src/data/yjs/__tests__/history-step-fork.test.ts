// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec section
 * 14: undo and redo judged on a copy of the document (design 5.2, the
 * "undo, redo" row), on plain Yjs types, the timeline edit session and the 3D
 * scene session.
 *
 * Below the limit a step runs as it is. While resyncing it is refused. When
 * the Space is full or over its ceiling, `nextHistoryStep` runs the same step
 * on a `gc: false` copy and judges what it wrote; the step then goes through
 * `writeSpaceDoc` with that kind. The plain-type cases drive it the way every
 * entry does (`gatedStep`, which is `runHistoryStep`).
 *
 * Round 6 (spec 14 head, H-01, H-14, H-19, 21.5, ST-01): `nextHistoryStep`
 * returns the kind itself; an empty stack is not tried; a manager reuses its
 * last conclusion while the top entry of that direction and the real
 * document's update count are unchanged; every entry runs `runHistoryStep`.
 * A copy is counted as an `encodeStateAsUpdate` of the real document (`yjs`
 * mocked passing through).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { SCENE_FORMAT_VERSION, type TimelineVideoSource } from '@breatic/shared';
import type * as YModule from 'yjs';
import type * as HistoryStepModule from '@web/data/yjs/history-step';

vi.mock('yjs', async (importOriginal) => {
  const actual = await importOriginal<typeof YModule>();
  return { ...actual, encodeStateAsUpdate: vi.fn(actual.encodeStateAsUpdate) };
});
vi.mock('@web/data/yjs/history-step', async (importOriginal) => {
  const actual = await importOriginal<typeof HistoryStepModule>();
  return {
    ...actual,
    runHistoryStep: vi.fn((...args: Parameters<typeof actual.runHistoryStep>) => actual.runHistoryStep(...args)),
  };
});

vi.mock('@web/lib/toast', () => ({
  toast: {
    warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(),
    loading: vi.fn(), promise: vi.fn(), dismiss: vi.fn(), custom: vi.fn(),
  },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, docNameOf, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { nextHistoryStep, runHistoryStep } from '@web/data/yjs/history-step';
import { readTimelineDocument } from '@web/data/yjs/timeline-document';
import { evictTimelineEditSession, getTimelineEditSession, type TimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import { readSceneDocument } from '@web/data/yjs/scene-document';
import { evictSceneSession, getSceneSession, type SceneSession } from '@web/data/yjs/scene-session';
import { MAIN, OFF, SOURCE, cid, clip, seededDoc, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  copiesOf,
  enterResync,
  enterSize,
  gatedStep,
  localUpdate,
  peerOf,
  realKind,
  redoneMap,
  resetCopies,
  spyOnSteps,
  trialFor,
  trialKind,
  trialRan,
  type StepSpies,
} from '@web/data/yjs/__tests__/helpers/history-fork-harness';
import { COPY_V2_EN, P_FULL, P_NORMAL, P_OVER, P_WARNING } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

const PID = 'p1';
const SID = 's1';
const NAME = docName.documentSpace(PID, SID);
const TIMELINE = docName.timelineSpace(PID, SID);
const SCENE = docName.threeDSpace(PID, SID);
/** The origin the plain-type undo managers track. */
const TRACKED = Symbol('tracked');

let spies: StepSpies;

/** A root fragment holding one paragraph of text, with an undo manager over it. */
interface Plain {
  doc: Y.Doc;
  fragment: Y.XmlFragment;
  text: Y.XmlText;
  manager: Y.UndoManager;
}

/**
 * The Space document with `f` > paragraph > text, seeded by an origin the
 * manager does not track.
 * @param content - The paragraph's text.
 * @param deleteFilter - The manager's delete filter.
 * @returns The document and its manager.
 */
function plain(content = 'hello world', deleteFilter?: (item: Y.Item) => boolean): Plain {
  const doc = getDoc(NAME);
  const fragment = doc.getXmlFragment('f');
  const text = new Y.XmlText();
  doc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph');
    fragment.insert(0, [paragraph]);
    paragraph.insert(0, [text]);
    text.insert(0, content);
  }, 'setup');
  const manager = new Y.UndoManager(fragment, { trackedOrigins: new Set([TRACKED]), captureTimeout: 0, ...(deleteFilter ? { deleteFilter } : {}) });
  return { doc, fragment, text, manager };
}

/**
 * Runs a write the manager tracks.
 * @param doc - The document.
 * @param write - The write.
 */
function tracked(doc: Y.Doc, write: () => void): void {
  doc.transact(write, TRACKED);
}

/**
 * The stack lengths.
 * @param manager - The manager.
 * @returns `[undo, redo]`.
 */
function stacks(manager: Y.UndoManager): [number, number] {
  return [manager.undoStack.length, manager.redoStack.length];
}

beforeEach(() => {
  changeLocale('en');
  spies = spyOnSteps();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  spies.restore();
  evictTimelineEditSession(TIMELINE);
  evictSceneSession(SCENE);
  clearAllDocSizes();
  _resetForTests();
});

describe('H-01 below the limit a step runs as it is, without a copy', () => {
  it.each([
    ['unknown', null],
    ['normal', P_NORMAL],
    ['warning', P_WARNING],
  ] as const)('H-01 %s: undoing a deletion brings the text back and judges nothing on a copy', (_label, push) => {
    const p = plain();
    tracked(p.doc, () => { p.text.delete(6, 5); });
    if (push !== null) enterSize(NAME, push);
    spies.undo.mockClear();
    resetCopies();

    expect(gatedStep(NAME, p.manager, 'undo')).toEqual({ ok: true });

    // Round 6: no copy is observed as no encoding of the real document.
    expect(copiesOf(p.doc)).toBe(0);
    expect(p.text.toString()).toBe('hello world');
    expect(spies.contexts()).toEqual([p.manager]);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('H-02 while resyncing every step is refused', () => {
  it('H-02 an undo is refused: stacks and document unchanged, no toast', () => {
    const p = plain();
    tracked(p.doc, () => { p.text.insert(11, '!'); });
    enterResync(NAME);
    const before = Y.encodeStateAsUpdate(p.doc);
    const lengths = stacks(p.manager);

    let result: unknown;
    const update = localUpdate(p.doc, () => { result = gatedStep(NAME, p.manager, 'undo'); });

    expect(result).toEqual({ ok: false, reason: 'resyncing' });
    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(p.doc)).toEqual(before);
    expect(stacks(p.manager)).toEqual(lengths);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('H-02 a redo is refused: stacks and document unchanged, no toast', () => {
    const p = plain();
    tracked(p.doc, () => { p.text.insert(11, '!'); });
    p.manager.undo();
    enterResync(NAME);
    const before = Y.encodeStateAsUpdate(p.doc);
    const lengths = stacks(p.manager);

    let result: unknown;
    const update = localUpdate(p.doc, () => { result = gatedStep(NAME, p.manager, 'redo'); });

    expect(result).toEqual({ ok: false, reason: 'resyncing' });
    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(p.doc)).toEqual(before);
    expect(stacks(p.manager)).toEqual(lengths);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('H-09 a step after merged neighbours is judged as the real undo', () => {
  it('H-09 delete, undo, an untracked write, a peer deletion and a second delete: the undo is an add and is refused', () => {
    const p = plain('hello world');
    const peer = peerOf(p.doc);
    tracked(p.doc, () => { p.text.delete(6, 5); });
    p.manager.undo();
    expect(p.text.toString()).toBe('hello world');
    // A local write the manager does not track.
    p.doc.transact(() => {
      const other = new Y.XmlElement('paragraph');
      p.fragment.insert(1, [other]);
      other.insert(0, [new Y.XmlText('other')]);
    }, 'untracked');
    // The peer deletes the space between the two words.
    const peerText = (peer.getXmlFragment('f').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    peerText.delete(5, 1);
    expect(p.text.toString()).toBe('helloworld');
    tracked(p.doc, () => { p.text.delete(0, 5); });
    enterSize(NAME, P_FULL);

    expect(trialKind(p.manager, 'undo')).toBe('add');
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(p.doc);
    const lengths = stacks(p.manager);

    let result: unknown;
    const update = localUpdate(p.doc, () => { result = gatedStep(NAME, p.manager, 'undo'); });

    expect(result).toEqual({ ok: false, reason: 'full' });
    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(p.doc)).toEqual(before);
    expect(stacks(p.manager)).toEqual(lengths);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_V2_EN.T_ADD);
    // The real undo agrees.
    expect(realKind(p.manager, 'undo')).toBe('add');
  });
});

describe('H-14 a scope the real document has deleted', () => {
  it('H-14 a nested body whose node a peer deleted: no effect, the undo still runs, no toast, nothing written', () => {
    const doc = getDoc(NAME);
    const nodes = doc.getMap<Y.Map<unknown>>('nodesMap');
    doc.transact(() => {
      const node = new Y.Map<unknown>();
      const data = new Y.Map<unknown>();
      const body = new Y.XmlFragment();
      nodes.set('n1', node);
      node.set('data', data);
      data.set('body', body);
      const paragraph = new Y.XmlElement('paragraph');
      body.insert(0, [paragraph]);
      paragraph.insert(0, [new Y.XmlText('hello')]);
    }, 'setup');
    const body = (nodes.get('n1')!.get('data') as Y.Map<unknown>).get('body') as Y.XmlFragment;
    const manager = new Y.UndoManager(body, { trackedOrigins: new Set([TRACKED]), captureTimeout: 0 });
    tracked(doc, () => { ((body.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(5, ' there'); });
    const peer = peerOf(doc);
    peer.getMap('nodesMap').delete('n1');
    expect(nodes.has('n1')).toBe(false);
    enterSize(NAME, P_FULL);

    // Round 6: the kind itself; no effect is `remove`.
    expect(nextHistoryStep(manager, 'undo')).toBe('remove');
    spies.undo.mockClear();
    const before = Y.encodeStateAsUpdate(doc);

    let result: unknown;
    const update = localUpdate(doc, () => { result = gatedStep(NAME, manager, 'undo'); });

    expect(result).toEqual({ ok: true });
    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(spies.undo.mock.contexts).toContain(manager);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('H-15 a scope the copy cannot resolve', () => {
  it('H-15 an undo manager over a detached fragment is not let through: T_ADD, nothing written', () => {
    const p = plain();
    tracked(p.doc, () => { p.text.insert(11, '!'); });
    const detached = new Y.UndoManager(new Y.XmlFragment(), { doc: p.doc, trackedOrigins: new Set([Symbol('none')]), captureTimeout: 0 });
    detached.undoStack.push(p.manager.undoStack[0]);
    enterSize(NAME, P_FULL);

    // Round 6 (spec 14 head): the kind itself; a scope that cannot be found is `add`.
    expect(nextHistoryStep(detached, 'undo')).toBe('add');
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(p.doc);

    let result: unknown;
    const update = localUpdate(p.doc, () => { result = gatedStep(NAME, detached, 'undo'); });

    expect(result).toEqual({ ok: false, reason: 'full' });
    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(p.doc)).toEqual(before);
    expect(detached.undoStack).toHaveLength(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_V2_EN.T_ADD);
  });
});

describe('H-16 a trial that throws', () => {
  it('H-16 the delete filter throws on the copy: refused with T_ADD, the real undo never runs', () => {
    const armed = { on: false };
    const p = plain('hello', () => {
      if (armed.on) throw new Error('filter boom');
      return true;
    });
    tracked(p.doc, () => { p.text.insert(5, ' world'); });
    armed.on = true;
    enterSize(NAME, P_FULL);
    spies.undo.mockClear();
    const before = Y.encodeStateAsUpdate(p.doc);
    const lengths = stacks(p.manager);

    let result: unknown;
    const update = localUpdate(p.doc, () => { result = gatedStep(NAME, p.manager, 'undo'); });

    expect(result).toEqual({ ok: false, reason: 'full' });
    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(p.doc)).toEqual(before);
    expect(stacks(p.manager)).toEqual(lengths);
    expect(spies.undo.mock.contexts).not.toContain(p.manager);
    expect(p.text.toString()).toBe('hello world');
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_V2_EN.T_ADD);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('H-17 the copy leaves the real document alone', () => {
  it('H-17 judging leaves the bytes, the redone pointers and the stacks as they were; the copy is not a cached document', () => {
    const p = plain('hello world');
    tracked(p.doc, () => { p.text.delete(6, 5); });
    p.manager.undo();
    tracked(p.doc, () => { p.text.insert(11, '!'); });
    enterSize(NAME, P_FULL);
    const before = Y.encodeStateAsUpdate(p.doc);
    const redone = redoneMap(p.doc);
    expect(redone.size).toBeGreaterThan(0);
    const lengths = stacks(p.manager);
    spies.undo.mockClear();

    expect(trialKind(p.manager, 'undo')).toBe('delete');

    expect(Y.encodeStateAsUpdate(p.doc)).toEqual(before);
    expect(redoneMap(p.doc)).toEqual(redone);
    expect(stacks(p.manager)).toEqual(lengths);
    const copies = spies.contexts().filter((manager) => manager.doc !== p.doc);
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) expect(docNameOf(copy.doc)).toBeNull();
    expect(spies.contexts()).not.toContain(p.manager);
  });
});

/**
 * The timeline Space document seeded with clips on the main track, and its
 * session, which may write.
 * @returns The document and the session.
 */
function timelineAt(): { doc: Y.Doc; session: TimelineEditSession } {
  const doc = getDoc(TIMELINE);
  const seeded = seededDoc(timeline([clip(cid(1), MAIN, 0, 48), clip(cid(2), MAIN, 48, 48)], [track(MAIN, 0)]));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seeded), 'remote');
  const session = getTimelineEditSession(doc, TIMELINE);
  session.setCanWrite(true);
  return { doc, session };
}

describe('H-20 timeline: undoing a deletion when full', () => {
  it('H-20 is refused with T_ADD, the step stays, the repair writes nothing', () => {
    const { doc, session } = timelineAt();
    expect(session.edit({ operation: 'delete', parameters: { clipId: cid(2) }, placement: OFF }).ok).toBe(true);
    expect(readTimelineDocument(doc).clips[cid(2)]).toBeUndefined();
    enterSize(TIMELINE, P_FULL);
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(doc);

    const update = localUpdate(doc, () => { session.undo(); });

    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).clips[cid(2)]).toBeUndefined();
    expect(session.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_V2_EN.T_ADD);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('H-21 timeline: undoing an add when full', () => {
  it('H-21 is judged on a copy as a remove and runs: the clip and its source go, and nothing else is written', () => {
    const { doc, session } = timelineAt();
    const fresh: TimelineVideoSource = { ...SOURCE, id: '10000000-0000-4000-8000-000000000077', assetId: '20000000-0000-4000-8000-000000000077' };
    const added = clip(cid(40), MAIN, 96, 30, { sourceId: fresh.id });
    expect(session.edit({ operation: 'add_video', parameters: { source: fresh, clip: added }, placement: OFF }).ok).toBe(true);
    enterSize(TIMELINE, P_FULL);
    vi.mocked(toast.warning).mockClear();
    spies.undo.mockClear();
    let localWrites = 0;
    const count = (_u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction): void => { if (tr.local) localWrites += 1; };
    doc.on('update', count);

    session.undo();

    doc.off('update', count);
    const after = readTimelineDocument(doc);
    expect(after.clips[added.id]).toBeUndefined();
    expect(after.sources[fresh.id]).toBeUndefined();
    expect(localWrites).toBe(1);
    expect(trialRan(spies, doc)).toBe(true);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';

/**
 * A valid builtin scene object.
 * @param id - Object id.
 * @returns The object.
 */
function sceneObject(id: string): { id: string; name: string; model: { kind: 'builtin'; id: 'figure' }; position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number]; locked: boolean } {
  return { id, name: 'Figure', model: { kind: 'builtin', id: 'figure' }, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
}

/**
 * The 3D Space document with object O1 as already-synced content, and an
 * editable session over it.
 * @returns The document and its session.
 */
function sceneAt(): { doc: Y.Doc; session: SceneSession } {
  const doc = getDoc(SCENE);
  doc.transact(() => {
    doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
    const { id, ...values } = sceneObject(O1);
    doc.getMap<unknown>('objects').set(id, new Y.Map<unknown>(Object.entries(values)));
  }, 'setup');
  const session = getSceneSession(doc, SCENE);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  return { doc, session };
}

/**
 * The object ids in the scene.
 * @param doc - The scene document.
 * @returns The ids.
 */
function sceneIds(doc: Y.Doc): string[] {
  return readSceneDocument(doc).objects.map((object) => object.id).sort();
}

describe('H-22 3D: historyStep when full', () => {
  it('H-22 undoing a create runs (a remove): the object goes, no toast', () => {
    const { doc, session } = sceneAt();
    expect(session.execute({ type: 'create', objects: [sceneObject(O2)] }).ok).toBe(true);
    expect(sceneIds(doc)).toEqual([O1, O2]);
    enterSize(SCENE, P_FULL);
    vi.mocked(toast.warning).mockClear();

    expect(session.historyStep('undo')).toEqual({ ok: true, ids: [] });

    expect(sceneIds(doc)).toEqual([O1]);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('H-22 undoing a delete is refused: one T_ADD from the session, the object stays deleted, the step stays', () => {
    const { doc, session } = sceneAt();
    expect(session.execute({ type: 'delete', ids: [O1] }).ok).toBe(true);
    expect(sceneIds(doc)).toEqual([]);
    enterSize(SCENE, P_FULL);
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(doc);

    const result = session.historyStep('undo');

    expect(result).toEqual({ ok: false, reason: 'full' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(sceneIds(doc)).toEqual([]);
    expect(session.getSnapshot().canUndo).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_V2_EN.T_ADD);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('H-22 over the ceiling undoing a create still runs', () => {
    const { doc, session } = sceneAt();
    expect(session.execute({ type: 'create', objects: [sceneObject(O2)] }).ok).toBe(true);
    enterSize(SCENE, P_OVER);
    vi.mocked(toast.warning).mockClear();

    expect(session.historyStep('undo')).toEqual({ ok: true, ids: [] });

    expect(sceneIds(doc)).toEqual([O1]);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('H-19 (round 6) timeline and 3D undo go through runHistoryStep', () => {
  it.each([
    ['full', P_FULL, COPY_V2_EN.T_ADD],
    ['over the ceiling', P_OVER, COPY_V2_EN.T_OVER],
  ] as const)('H-19 timeline session undo() of a deletion %s: runHistoryStep once, refused with its toast, the step stays', (_label, push, sentence) => {
    const { doc, session } = timelineAt();
    expect(session.edit({ operation: 'delete', parameters: { clipId: cid(2) }, placement: OFF }).ok).toBe(true);
    enterSize(TIMELINE, push);
    vi.mocked(toast.warning).mockClear();
    vi.mocked(runHistoryStep).mockClear();
    const before = Y.encodeStateAsUpdate(doc);

    const update = localUpdate(doc, () => { session.undo(); });

    expect(vi.mocked(runHistoryStep)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runHistoryStep)).toHaveBeenCalledWith(TIMELINE, expect.any(Y.UndoManager), 'undo');
    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(session.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(sentence);
  });

  it.each([
    ['full', P_FULL, COPY_V2_EN.T_ADD],
    ['over the ceiling', P_OVER, COPY_V2_EN.T_OVER],
  ] as const)('H-19 3D historyStep(undo) of a delete %s: runHistoryStep once, refused with its toast, the step stays', (_label, push, sentence) => {
    const { doc, session } = sceneAt();
    expect(session.execute({ type: 'delete', ids: [O1] }).ok).toBe(true);
    enterSize(SCENE, push);
    vi.mocked(toast.warning).mockClear();
    vi.mocked(runHistoryStep).mockClear();
    const before = Y.encodeStateAsUpdate(doc);

    const update = localUpdate(doc, () => { session.historyStep('undo'); });

    expect(vi.mocked(runHistoryStep)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runHistoryStep)).toHaveBeenCalledWith(SCENE, expect.any(Y.UndoManager), 'undo');
    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(session.getSnapshot().canUndo).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(sentence);
  });
});

const CANVAS = docName.canvasSpace(PID, SID);

/** A canvas document whose `nodesMap` an undo manager tracks. */
interface Board {
  doc: Y.Doc;
  nodes: Y.Map<unknown>;
  manager: Y.UndoManager;
}

/**
 * The canvas Space document with node `n2` already synced, and an undo
 * manager over `nodesMap` with empty stacks.
 * @returns The board.
 */
function board(): Board {
  const doc = getDoc(CANVAS);
  const nodes = doc.getMap<unknown>('nodesMap');
  doc.transact(() => { nodes.set('n2', new Y.Map<unknown>([['name', 'two']])); }, 'setup');
  const manager = new Y.UndoManager(nodes, { trackedOrigins: new Set([TRACKED]), captureTimeout: 0 });
  return { doc, nodes, manager };
}

/**
 * HC-04's history: `n1` set, then deleted, each its own step; undoing the
 * deletion brings content back (an `add`).
 * @returns The board.
 */
function restoredStepBoard(): Board {
  const b = board();
  tracked(b.doc, () => { b.nodes.set('n1', new Y.Map<unknown>([['name', 'one']])); });
  tracked(b.doc, () => { b.nodes.delete('n1'); });
  expect(b.manager.undoStack).toHaveLength(2);
  return b;
}

describe('HC-01 and HC-02 an empty stack is not tried', () => {
  it.each(['undo', 'redo'] as const)('HC-01/HC-02 full, empty %s stack: three judgements copy nothing and each answers remove', (direction) => {
    const b = board();
    enterSize(CANVAS, P_FULL);
    resetCopies();

    const kinds = [1, 2, 3].map(() => nextHistoryStep(b.manager, direction));

    expect(copiesOf(b.doc)).toBe(0);
    expect(kinds).toEqual(['remove', 'remove', 'remove']);
  });
});

describe('HC-03 timeline and 3D entries on empty stacks when full', () => {
  it('HC-03 timeline session undo() and redo(): no copy, nothing written, no toast', () => {
    const { doc, session } = timelineAt();
    expect(session.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false });
    enterSize(TIMELINE, P_FULL);
    vi.mocked(toast.warning).mockClear();
    resetCopies();

    const update = localUpdate(doc, () => { session.undo(); session.redo(); });

    expect(copiesOf(doc)).toBe(0);
    expect(update).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('HC-03 3D historyStep(undo) and historyStep(redo): no copy, nothing written, no toast', () => {
    const { doc, session } = sceneAt();
    expect(session.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false });
    enterSize(SCENE, P_FULL);
    vi.mocked(toast.warning).mockClear();
    resetCopies();

    const update = localUpdate(doc, () => { session.historyStep('undo'); session.historyStep('redo'); });

    expect(copiesOf(doc)).toBe(0);
    expect(update).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('HC-04 to HC-08 a manager reuses its last conclusion', () => {
  it('HC-04 three presses on a refused restore: one copy, three refusals each with T_ADD, the stacks stay', () => {
    const b = restoredStepBoard();
    enterSize(CANVAS, P_FULL);
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(b.doc);
    const lengths = stacks(b.manager);
    resetCopies();

    const results = [1, 2, 3].map(() => gatedStep(CANVAS, b.manager, 'undo'));

    expect(copiesOf(b.doc)).toBe(1);
    expect(results).toEqual([{ ok: false, reason: 'full' }, { ok: false, reason: 'full' }, { ok: false, reason: 'full' }]);
    expect(vi.mocked(toast.warning).mock.calls.map(([message]) => message)).toEqual([COPY_V2_EN.T_ADD, COPY_V2_EN.T_ADD, COPY_V2_EN.T_ADD]);
    expect(stacks(b.manager)).toEqual(lengths);
    expect(Y.encodeStateAsUpdate(b.doc)).toEqual(before);
  });

  it('HC-05 a peer update between presses (an unrelated node) makes the second press copy again; still an add', () => {
    const b = restoredStepBoard();
    const peer = peerOf(b.doc);
    enterSize(CANVAS, P_FULL);
    resetCopies();

    expect(gatedStep(CANVAS, b.manager, 'undo')).toEqual({ ok: false, reason: 'full' });
    expect(copiesOf(b.doc)).toBe(1);
    (peer.getMap<unknown>('nodesMap').get('n2') as Y.Map<unknown>).set('name', 'peer');
    expect((b.nodes.get('n2') as Y.Map<unknown>).get('name')).toBe('peer');
    expect(nextHistoryStep(b.manager, 'undo')).toBe('add');

    expect(copiesOf(b.doc)).toBe(2);
  });

  it('HC-06 a local write the manager does not track between presses makes the second press copy again', () => {
    const b = restoredStepBoard();
    enterSize(CANVAS, P_FULL);
    resetCopies();

    expect(gatedStep(CANVAS, b.manager, 'undo')).toEqual({ ok: false, reason: 'full' });
    b.doc.transact(() => { b.nodes.set('n3', 'untracked'); }, 'untracked');
    expect(stacks(b.manager)).toEqual([2, 0]);
    expect(gatedStep(CANVAS, b.manager, 'undo')).toEqual({ ok: false, reason: 'full' });

    expect(copiesOf(b.doc)).toBe(2);
  });

  it('HC-07 (a) a new tracked step changes the top entry: the next undo copies again', () => {
    const b = restoredStepBoard();
    enterSize(CANVAS, P_FULL);
    resetCopies();

    expect(gatedStep(CANVAS, b.manager, 'undo')).toEqual({ ok: false, reason: 'full' });
    tracked(b.doc, () => { b.nodes.set('n4', 'x'); });
    nextHistoryStep(b.manager, 'undo');

    expect(copiesOf(b.doc)).toBe(2);
  });

  it('HC-07 (b) the redo direction does not reuse the undo conclusion: an empty redo stack answers remove without a copy', () => {
    const b = restoredStepBoard();
    enterSize(CANVAS, P_FULL);
    resetCopies();

    expect(gatedStep(CANVAS, b.manager, 'undo')).toEqual({ ok: false, reason: 'full' });
    expect(nextHistoryStep(b.manager, 'redo')).toBe('remove');

    expect(copiesOf(b.doc)).toBe(1);
  });

  it('HC-08 after a refused press, over the ceiling: T_OVER without a copy; then warning: no trial, the undo runs', () => {
    const b = restoredStepBoard();
    enterSize(CANVAS, P_FULL);
    resetCopies();
    expect(gatedStep(CANVAS, b.manager, 'undo')).toEqual({ ok: false, reason: 'full' });
    expect(copiesOf(b.doc)).toBe(1);

    enterSize(CANVAS, P_OVER);
    vi.mocked(toast.warning).mockClear();
    expect(gatedStep(CANVAS, b.manager, 'undo')).toEqual({ ok: false, reason: 'over_ceiling' });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_V2_EN.T_OVER);
    expect(copiesOf(b.doc)).toBe(1);

    enterSize(CANVAS, P_WARNING);
    vi.mocked(toast.warning).mockClear();
    expect(gatedStep(CANVAS, b.manager, 'undo')).toEqual({ ok: true });
    expect(copiesOf(b.doc)).toBe(1);
    expect(b.nodes.has('n1')).toBe(true);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

/**
 * W7-36's history on a canvas document with an empty `nodesMap`: in warning,
 * `n1` set, `n1` deleted and `n2` set, each its own step, then one undo
 * (of `n2`). The redo stack holds one entry and the undo stack's top is the
 * deletion of `n1`.
 * @returns The board.
 */
function clearedStackBoard(): Board {
  const doc = getDoc(CANVAS);
  const nodes = doc.getMap<unknown>('nodesMap');
  const manager = new Y.UndoManager(nodes, { trackedOrigins: new Set([TRACKED]), captureTimeout: 0 });
  enterSize(CANVAS, P_WARNING);
  tracked(doc, () => { nodes.set('n1', new Y.Map<unknown>([['name', 'one']])); });
  tracked(doc, () => { nodes.delete('n1'); });
  tracked(doc, () => { nodes.set('n2', new Y.Map<unknown>([['name', 'two']])); });
  manager.undo();
  expect(nodes.has('n2')).toBe(false);
  expect(stacks(manager)).toEqual([2, 1]);
  return { doc, nodes, manager };
}

describe('23.7 the cache key is the top entry of that direction and the update count', () => {
  it('W7-36 clearing only the redo stack keeps the undo conclusion: no second copy, still the real undo kind', () => {
    const b = clearedStackBoard();
    enterSize(CANVAS, P_FULL);
    resetCopies();
    expect(nextHistoryStep(b.manager, 'undo')).toBe('add');
    expect(copiesOf(b.doc)).toBe(1);

    b.manager.clear(false, true);
    expect(stacks(b.manager)).toEqual([2, 0]);
    const kind = nextHistoryStep(b.manager, 'undo');

    expect(copiesOf(b.doc)).toBe(1);
    expect(kind).toBe(trialFor(realKind(b.manager, 'undo')));
  });

  it('W7-37 clearing only the undo stack answers remove without a copy; a new tracked step is then tried afresh', () => {
    const b = clearedStackBoard();
    enterSize(CANVAS, P_FULL);
    resetCopies();
    expect(nextHistoryStep(b.manager, 'undo')).toBe('add');
    expect(copiesOf(b.doc)).toBe(1);

    b.manager.clear(true, false);
    expect(nextHistoryStep(b.manager, 'undo')).toBe('remove');
    expect(copiesOf(b.doc)).toBe(1);

    tracked(b.doc, () => { b.nodes.set('n3', new Y.Map<unknown>([['name', 'three']])); });
    resetCopies();
    const kind = nextHistoryStep(b.manager, 'undo');

    expect(copiesOf(b.doc)).toBe(1);
    expect(kind).toBe(trialFor(realKind(b.manager, 'undo')));
  });

  it('W7-38 clearing only the undo stack keeps the redo conclusion: no second copy, still the real redo kind', () => {
    const b = clearedStackBoard();
    enterSize(CANVAS, P_FULL);
    resetCopies();
    nextHistoryStep(b.manager, 'redo');
    expect(copiesOf(b.doc)).toBe(1);

    b.manager.clear(true, false);
    expect(stacks(b.manager)).toEqual([0, 1]);
    const kind = nextHistoryStep(b.manager, 'redo');

    expect(copiesOf(b.doc)).toBe(1);
    expect(kind).toBe(trialFor(realKind(b.manager, 'redo')));
  });
});

describe('HC-10 timeline: holding undo on a refused step', () => {
  it('HC-10 thirty undo() presses after deleting c2 when full copy the document once; the step stays', () => {
    const { doc, session } = timelineAt();
    expect(session.edit({ operation: 'delete', parameters: { clipId: cid(2) }, placement: OFF }).ok).toBe(true);
    enterSize(TIMELINE, P_FULL);
    const before = Y.encodeStateAsUpdate(doc);
    resetCopies();

    for (let press = 0; press < 30; press += 1) session.undo();

    expect(copiesOf(doc)).toBe(1);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(session.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false });
  });
});

describe('ST-01 the module surface', () => {
  it('ST-01 history-step exports runHistoryStep; timeline-document no longer exports timelineSizeName', async () => {
    const m = await vi.importActual<typeof HistoryStepModule>('@web/data/yjs/history-step');
    const t = await import('@web/data/yjs/timeline-document');

    expect(typeof m.runHistoryStep).toBe('function');
    expect('timelineSizeName' in t).toBe(false);
  });
});
