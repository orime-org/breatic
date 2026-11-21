// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { addNode, CANVAS_UNDO, createCanvasUndoManager, nodeDataMap, removeNode } from '../canvas-space';
import { _resetForTests, docName, getDoc } from '../manager';

type ToolId = 'video.extract-frames' | 'video.split';

interface Draft {
  version: 1;
  draftId: string;
  revision: string;
  source: { nodeId: string; canonicalURL: string; mediaInfo: { width: number; height: number; duration: number; mimeType: string } };
  params: Record<string, unknown>;
  inputs: { inputId: string; url: string; cover?: string; sourceNodeId?: string }[];
  presentationRef?: PresentationRef;
}

interface PresentationRef { source: { toolInputId: string; planSha256: string } }

interface AnalysisRef {
  version: 1;
  draftId: string;
  toolId: ToolId;
  kind: 'scene_cuts';
  analysisRunId: string;
  inputFingerprint: string;
}

type DraftReading =
  | { state: 'absent' }
  | { state: 'supported' | 'stale'; draft: Draft }
  | { state: 'unsupported'; value: unknown }
  | { state: 'invalid'; value: unknown };

interface DraftApi {
  readVideoToolDraft: (doc: Y.Doc, nodeId: string, toolId: ToolId, presentationRef?: PresentationRef) => DraftReading;
  rebindVideoToolDraft: (doc: Y.Doc, nodeId: string, toolId: ToolId, presentationRef: PresentationRef, revision: string) => boolean;
  commitVideoToolDraft: (doc: Y.Doc, nodeId: string, toolId: ToolId, draft: Draft) => boolean;
  commitVideoToolAnalysisRef: (doc: Y.Doc, nodeId: string, ref: AnalysisRef) => boolean;
  clearVideoToolDraft: (doc: Y.Doc, nodeId: string, toolId: ToolId) => boolean;
  commitVideoSceneAnalysis: (doc: Y.Doc, nodeId: string, record: unknown) => 'applied' | 'superseded' | 'ignored';
}

// The public-entry assertion remains collectable before this module exists.
const candidates = import.meta.glob('../video-tool-drafts.ts');
let api: DraftApi;
let counter = 0;
const documents: Y.Doc[] = [];
const managers: Y.UndoManager[] = [];
const hostId = '10000000-0000-4000-8000-000000000001';
const draftId = '20000000-0000-4000-8000-000000000001';
const otherDraftId = '20000000-0000-4000-8000-000000000002';
const firstRevision = '30000000-0000-4000-8000-000000000001';
const secondRevision = '30000000-0000-4000-8000-000000000002';
const thirdRevision = '30000000-0000-4000-8000-000000000003';
const firstRunId = '40000000-0000-4000-8000-000000000001';
const secondRunId = '40000000-0000-4000-8000-000000000002';
const thirdRunId = '40000000-0000-4000-8000-000000000003';
const sourceURL = 'https://media.example.test/source.mp4';

/** Builds the approved split draft fixture. */
function splitDraft(params: Record<string, unknown> = { cuts: [1], sensitivity: 0.4 }, overrides: Partial<Draft> = {}): Draft {
  return {
    version: 1, draftId, revision: firstRevision,
    source: { nodeId: hostId, canonicalURL: sourceURL, mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } },
    params, inputs: [], ...overrides,
  };
}

/** Builds one accepted scene analysis reference. */
function analysisRef(overrides: Partial<AnalysisRef> = {}): AnalysisRef {
  return { version: 1, draftId, toolId: 'video.split', kind: 'scene_cuts', analysisRunId: firstRunId, inputFingerprint: 'a'.repeat(64), ...overrides };
}

/** Creates a managed document with its real raw video node. */
function space(): { projectId: string; spaceId: string; doc: Y.Doc } {
  counter += 1;
  const projectId = `video-draft-project-${counter}`;
  const spaceId = `video-draft-space-${counter}`;
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  documents.push(doc);
  addNode(projectId, spaceId, {
    id: hostId, type: 'video', position: { x: 24, y: 48 },
    data: { name: 'Source video', createdAt: 0, createdBy: 'video-draft-test', locked: false, attachments: [], content: sourceURL },
  });
  return { projectId, spaceId, doc };
}

/** Reads the actual nested node data map. */
function dataOf(doc: Y.Doc): Y.Map<unknown> {
  const data = nodeDataMap(doc, hostId);
  if (data === null) throw new Error('Missing fixture node');
  return data;
}

/** Creates a disconnected collaborator sharing the original document state. */
function collaborator(doc: Y.Doc): Y.Doc {
  // A managed document of its own: every local Space write goes through the size gate, which writes only to a named doc.
  counter += 1;
  const peer = getDoc(docName.canvasSpace(`video-draft-peer-project-${counter}`, `video-draft-peer-space-${counter}`));
  documents.push(peer);
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc), 'remote');
  return peer;
}

/** Exchanges both offline states after each collaborator has written. */
function merge(a: Y.Doc, b: Y.Doc): void {
  const aUpdate = Y.encodeStateAsUpdate(a);
  const bUpdate = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, bUpdate, 'remote');
  Y.applyUpdate(b, aUpdate, 'remote');
}

/** Tracks the same node and edge maps as the live canvas. */
function undoManager(doc: Y.Doc): Y.UndoManager {
  const manager = createCanvasUndoManager(doc);
  managers.push(manager);
  return manager;
}

beforeAll(async () => {
  const load = candidates['../video-tool-drafts.ts'];
  api = (load === undefined ? {} : await load()) as DraftApi;
});

beforeEach(() => {
  _resetForTests();
});

afterEach(() => {
  managers.splice(0).forEach((manager) => manager.destroy());
  documents.splice(0).forEach((doc) => doc.destroy());
  _resetForTests();
});

describe('video mini-tool raw draft storage', () => {
  it('exports the four persistent draft entry points', () => {
    expect(['readVideoToolDraft', 'commitVideoToolDraft', 'commitVideoToolAnalysisRef', 'clearVideoToolDraft'].filter((key) => !(key in api))).toEqual([]);
  });

  it('stores one complete scalar snapshot under its tool key and CANVAS_UNDO origin', () => {
    const { doc } = space();
    const draft = splitDraft();
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction) => origins.push(transaction.origin));
    expect(api.commitVideoToolDraft(doc, hostId, 'video.split', draft)).toBe(true);
    expect(origins).toEqual([CANVAS_UNDO]);
    expect(dataOf(doc).get('miniToolDraft:video.split')).toEqual(draft);
    expect(dataOf(doc).get('miniToolDraft:video.split')).not.toBeInstanceOf(Y.Map);
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toEqual({ state: 'supported', draft });
  });

  it('reads an absent draft without adding fields to a legacy node', () => {
    const { doc } = space();
    const before = dataOf(doc).toJSON();
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toEqual({ state: 'absent' });
    expect(dataOf(doc).toJSON()).toEqual(before);
  });

  it('leaves a missing host unchanged for reads, commits, analysis references and clears', () => {
    const { doc } = space();
    const missing = '10000000-0000-4000-8000-000000000099';
    const before = doc.getMap('nodesMap').toJSON();
    expect(api.readVideoToolDraft(doc, missing, 'video.split')).toEqual({ state: 'absent' });
    expect(api.commitVideoToolDraft(doc, missing, 'video.split', splitDraft())).toBe(false);
    expect(api.commitVideoToolAnalysisRef(doc, missing, analysisRef())).toBe(false);
    expect(api.clearVideoToolDraft(doc, missing, 'video.split')).toBe(false);
    expect(doc.getMap('nodesMap').toJSON()).toEqual(before);
  });

  it.each([
    { ...splitDraft(), draftId: 'invalid-draft-id' },
    { ...splitDraft(), revision: 'invalid-revision' },
    { ...splitDraft(), params: { cuts: [Number.NaN], sensitivity: 0.4 } },
  ])('rejects invalid committed snapshots without changing the previous draft %#', (invalid) => {
    const { doc } = space();
    const original = splitDraft();
    api.commitVideoToolDraft(doc, hostId, 'video.split', original);
    expect(() => api.commitVideoToolDraft(doc, hostId, 'video.split', invalid)).toThrow();
    expect(dataOf(doc).get('miniToolDraft:video.split')).toEqual(original);
  });

  it('preserves unsupported versions while reporting their read state', () => {
    const { doc } = space();
    const value = { ...splitDraft(), version: 2, futureField: { enabled: true } };
    dataOf(doc).set('miniToolDraft:video.split', value);
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toEqual({ state: 'unsupported', value });
    expect(dataOf(doc).get('miniToolDraft:video.split')).toEqual(value);
  });

  it.each([null, [], 'invalid', { version: 1 }, { ...splitDraft(), revision: 'invalid' }])('preserves malformed stored values while reporting invalid state %#', (value) => {
    const { doc } = space();
    dataOf(doc).set('miniToolDraft:video.split', value);
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toEqual({ state: 'invalid', value });
    expect(dataOf(doc).get('miniToolDraft:video.split')).toEqual(value);
  });

  it('keeps the saved source and parameters when the host media changes', () => {
    const { doc } = space();
    const draft = splitDraft();
    api.commitVideoToolDraft(doc, hostId, 'video.split', draft);
    dataOf(doc).set('content', 'https://media.example.test/replacement.mp4');
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toEqual({ state: 'supported', draft });
    expect(dataOf(doc).get('content')).toBe('https://media.example.test/replacement.mp4');
  });

  it('keeps independent tool snapshots after disconnected collaborators merge', () => {
    const { doc: a } = space();
    const b = collaborator(a);
    const split = splitDraft();
    const frames = splitDraft({ mode: 'first', frameIndex: 0 }, { draftId: otherDraftId, revision: secondRevision });
    api.commitVideoToolDraft(a, hostId, 'video.split', split);
    api.commitVideoToolDraft(b, hostId, 'video.extract-frames', frames);
    merge(a, b);
    for (const doc of [a, b]) {
      expect(dataOf(doc).get('miniToolDraft:video.split')).toEqual(split);
      expect(dataOf(doc).get('miniToolDraft:video.extract-frames')).toEqual(frames);
    }
  });

  it('converges concurrent edits to one complete snapshot of the same tool', () => {
    const cuts = fc.uniqueArray(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 }).map((values) => values.sort((a, b) => a - b));
    fc.assert(fc.property(cuts, cuts, (leftCuts, rightCuts) => {
      const { doc: a } = space();
      const b = collaborator(a);
      const left = splitDraft({ cuts: leftCuts, sensitivity: 0.4 }, { revision: secondRevision });
      const right = splitDraft({ cuts: rightCuts, sensitivity: 0.7 }, { revision: thirdRevision });
      api.commitVideoToolDraft(a, hostId, 'video.split', left);
      api.commitVideoToolDraft(b, hostId, 'video.split', right);
      merge(a, b);
      const actual = dataOf(a).get('miniToolDraft:video.split');
      expect(dataOf(b).get('miniToolDraft:video.split')).toEqual(actual);
      expect([left, right]).toContainEqual(actual);
    }));
  });

  it('undoes parameters while local and remote accepted analysis references survive', () => {
    const { doc: a } = space();
    const initial = splitDraft();
    api.commitVideoToolDraft(a, hostId, 'video.split', initial);
    const b = collaborator(a);
    const undo = undoManager(a);
    const changed = splitDraft({ cuts: [2], sensitivity: 0.4 }, { revision: secondRevision });
    api.commitVideoToolDraft(a, hostId, 'video.split', changed);
    const local = analysisRef();
    const remote = analysisRef({ analysisRunId: secondRunId });
    api.commitVideoToolAnalysisRef(a, hostId, local);
    api.commitVideoToolAnalysisRef(b, hostId, remote);
    merge(a, b);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(dataOf(a).get('miniToolDraft:video.split')).toEqual(initial);
    expect(dataOf(a).get(`miniToolAnalysis:${firstRunId}`)).toEqual(local);
    expect(dataOf(a).get(`miniToolAnalysis:${secondRunId}`)).toEqual(remote);
    undo.redo();
    expect(dataOf(a).get('miniToolDraft:video.split')).toEqual(changed);
    expect(dataOf(a).get(`miniToolAnalysis:${firstRunId}`)).toEqual(local);
    expect(dataOf(a).get(`miniToolAnalysis:${secondRunId}`)).toEqual(remote);
  });

  it('keeps two concurrent analyses of the same kind under independent run keys', () => {
    const { doc: a } = space();
    api.commitVideoToolDraft(a, hostId, 'video.split', splitDraft());
    const b = collaborator(a);
    const first = analysisRef();
    const second = analysisRef({ analysisRunId: secondRunId, inputFingerprint: 'b'.repeat(64) });
    api.commitVideoToolAnalysisRef(a, hostId, first);
    api.commitVideoToolAnalysisRef(b, hostId, second);
    merge(a, b);
    for (const doc of [a, b]) {
      expect(dataOf(doc).get(`miniToolAnalysis:${firstRunId}`)).toEqual(first);
      expect(dataOf(doc).get(`miniToolAnalysis:${secondRunId}`)).toEqual(second);
      expect(dataOf(doc).get('miniToolDraft:video.split')).toEqual(splitDraft());
    }
  });

  it('replays an identical accepted analysis without another Yjs update or undo step', () => {
    const { doc } = space();
    api.commitVideoToolDraft(doc, hostId, 'video.split', splitDraft());
    const undo = undoManager(doc);
    const ref = analysisRef();
    expect(api.commitVideoToolAnalysisRef(doc, hostId, ref)).toBe(true);
    const updates = vi.fn();
    doc.on('update', updates);
    expect(api.commitVideoToolAnalysisRef(doc, hostId, structuredClone(ref))).toBe(true);
    expect(updates).toHaveBeenCalledTimes(0);
    expect(undo.undoStack).toHaveLength(0);
    expect(dataOf(doc).get(`miniToolAnalysis:${firstRunId}`)).toEqual(ref);
  });

  it('rejects a conflicting value for an accepted run and retains its original reference', () => {
    const { doc } = space();
    const ref = analysisRef();
    api.commitVideoToolAnalysisRef(doc, hostId, ref);
    expect(() => api.commitVideoToolAnalysisRef(doc, hostId, { ...ref, inputFingerprint: 'b'.repeat(64) })).toThrow();
    expect(dataOf(doc).get(`miniToolAnalysis:${firstRunId}`)).toEqual(ref);
  });

  it('rejects an invalid analysis reference without changing node data', () => {
    const { doc } = space();
    const before = dataOf(doc).toJSON();
    expect(() => api.commitVideoToolAnalysisRef(doc, hostId, { ...analysisRef(), analysisRunId: 'invalid-run' })).toThrow();
    expect(dataOf(doc).toJSON()).toEqual(before);
  });

  it('clears one tool and its own analysis references in one undoable transaction', () => {
    const { doc } = space();
    const draft = splitDraft();
    const frames = splitDraft({ mode: 'first', frameIndex: 0 }, { draftId: otherDraftId });
    api.commitVideoToolDraft(doc, hostId, 'video.split', draft);
    api.commitVideoToolDraft(doc, hostId, 'video.extract-frames', frames);
    const own = analysisRef();
    const ownSecond = analysisRef({ analysisRunId: secondRunId });
    const other = analysisRef({ draftId: otherDraftId, analysisRunId: thirdRunId });
    api.commitVideoToolAnalysisRef(doc, hostId, own);
    api.commitVideoToolAnalysisRef(doc, hostId, ownSecond);
    api.commitVideoToolAnalysisRef(doc, hostId, other);
    const undo = undoManager(doc);
    expect(api.clearVideoToolDraft(doc, hostId, 'video.split')).toBe(true);
    expect(undo.undoStack).toHaveLength(1);
    expect(dataOf(doc).has('miniToolDraft:video.split')).toBe(false);
    expect(dataOf(doc).has(`miniToolAnalysis:${firstRunId}`)).toBe(false);
    expect(dataOf(doc).has(`miniToolAnalysis:${secondRunId}`)).toBe(false);
    expect(dataOf(doc).get('miniToolDraft:video.extract-frames')).toEqual(frames);
    expect(dataOf(doc).get(`miniToolAnalysis:${thirdRunId}`)).toEqual(other);
    undo.undo();
    expect(dataOf(doc).get('miniToolDraft:video.split')).toEqual(draft);
    expect(dataOf(doc).get(`miniToolAnalysis:${firstRunId}`)).toEqual(own);
    expect(dataOf(doc).get(`miniToolAnalysis:${secondRunId}`)).toEqual(ownSecond);
    expect(dataOf(doc).get(`miniToolAnalysis:${thirdRunId}`)).toEqual(other);
    undo.redo();
    expect(dataOf(doc).has('miniToolDraft:video.split')).toBe(false);
    expect(dataOf(doc).has(`miniToolAnalysis:${firstRunId}`)).toBe(false);
    expect(dataOf(doc).get(`miniToolAnalysis:${thirdRunId}`)).toEqual(other);
  });

  it('leaves absent tool state and undo history unchanged when clearing', () => {
    const { doc } = space();
    const undo = undoManager(doc);
    const before = dataOf(doc).toJSON();
    expect(api.clearVideoToolDraft(doc, hostId, 'video.split')).toBe(false);
    expect(dataOf(doc).toJSON()).toEqual(before);
    expect(undo.undoStack).toHaveLength(0);
  });

  it('restores the complete draft and analysis reference when a host deletion is undone', () => {
    const { projectId, spaceId, doc } = space();
    const draft = splitDraft();
    const ref = analysisRef();
    api.commitVideoToolDraft(doc, hostId, 'video.split', draft);
    api.commitVideoToolAnalysisRef(doc, hostId, ref);
    const undo = undoManager(doc);
    removeNode(projectId, spaceId, hostId);
    expect(nodeDataMap(doc, hostId)).toBeNull();
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(dataOf(doc).get('miniToolDraft:video.split')).toEqual(draft);
    expect(dataOf(doc).get(`miniToolAnalysis:${firstRunId}`)).toEqual(ref);
    undo.redo();
    expect(nodeDataMap(doc, hostId)).toBeNull();
  });
});


describe('durable scene result application', () => {
  /** The independent application oracle's complete accepted scene result. */
  function completedScene(runId = firstRunId): Record<string, unknown> {
    const binding = {
      assetId: '50000000-0000-4000-8000-000000000001', contentHash: 'b'.repeat(64),
      canonicalURL: sourceURL, kind: 'video',
      mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' },
    };
    const identity = {
      schemaVersion: 1, draftId, revision: firstRevision, analysisRunId: runId,
      acceptedAt: '2026-10-25T09:03:03.100001Z', kind: 'scene_cuts', binding,
      analysisInput: { schemaVersion: 1, kind: 'scene_cuts', sourceURL, range: { start: 0, end: 125 }, profile: { id: 'pyscenedetect-content', version: '0.7.2', weightsHash: null, params: { threshold: 27, minSceneLength: 15 } } },
      inputFingerprint: 'a'.repeat(64),
    };
    return { ...identity, status: 'completed', result: { ...identity, fps: { numerator: 25, denominator: 1 }, frameCount: 125, cuts: [{ frameIndex: 43, detectionScore: 31 }, { frameIndex: 85, detectionScore: 47 }] }, error: null, usage: [], artifactUnavailable: false };
  }

  /** Creates the accepted run's editable source without tracking setup in undo. */
  function sceneSpace(): Y.Doc {
    const { doc } = space();
    api.commitVideoToolDraft(doc, hostId, 'video.split', splitDraft({ cuts: [] }));
    api.commitVideoToolAnalysisRef(doc, hostId, analysisRef());
    return doc;
  }

  it('applies a matching result as one atomic parameter undo step and ignores repeated notifications', () => {
    const doc = sceneSpace();
    const undo = undoManager(doc);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction) => origins.push(transaction.origin));
    const record = completedScene();
    const before = structuredClone(record);
    expect(api.commitVideoSceneAnalysis(doc, hostId, record)).toBe('applied');
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toMatchObject({ state: 'supported', draft: { params: { cuts: [43, 85] } } });
    expect(origins).toEqual([CANVAS_UNDO]);
    expect(undo.undoStack).toHaveLength(1);
    expect(api.commitVideoSceneAnalysis(doc, hostId, record)).toBe('ignored');
    expect(undo.undoStack).toHaveLength(1);
    expect(record).toEqual(before);
  });

  it('preserves the application fact across undo, redo and a newly mounted manager', () => {
    const doc = sceneSpace();
    const original = splitDraft({ cuts: [] });
    const undo = undoManager(doc);
    expect(api.commitVideoSceneAnalysis(doc, hostId, completedScene())).toBe('applied');
    undo.undo();
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toEqual({ state: 'supported', draft: original });
    expect(api.commitVideoSceneAnalysis(doc, hostId, completedScene())).toBe('ignored');
    undo.redo();
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toMatchObject({ state: 'supported', draft: { params: { cuts: [43, 85] } } });
    undo.undo();
    undo.destroy();
    const remounted = undoManager(doc);
    expect(api.commitVideoSceneAnalysis(doc, hostId, completedScene())).toBe('ignored');
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toEqual({ state: 'supported', draft: original });
    expect(remounted.undoStack).toHaveLength(0);
  });

  it('lets a newly accepted run apply after the previous result was undone', () => {
    const doc = sceneSpace();
    const undo = undoManager(doc);
    expect(api.commitVideoSceneAnalysis(doc, hostId, completedScene())).toBe('applied');
    undo.undo();
    api.commitVideoToolAnalysisRef(doc, hostId, analysisRef({ analysisRunId: secondRunId }));
    expect(api.commitVideoSceneAnalysis(doc, hostId, completedScene(secondRunId))).toBe('applied');
    expect(undo.undoStack).toHaveLength(1);
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toMatchObject({ state: 'supported', draft: { params: { cuts: [43, 85] } } });
  });

  it('retains a manual edit made before the accepted result arrives and reports the result superseded', () => {
    const doc = sceneSpace();
    const edited = splitDraft({ cuts: [30] }, { revision: secondRevision });
    api.commitVideoToolDraft(doc, hostId, 'video.split', edited);
    const undo = undoManager(doc);
    expect(api.commitVideoSceneAnalysis(doc, hostId, completedScene())).toBe('superseded');
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toEqual({ state: 'supported', draft: edited });
    expect(undo.undoStack).toHaveLength(0);
  });

  it('keeps the receipt when an undone result is synchronized to another real document', () => {
    const doc = sceneSpace();
    const peer = collaborator(doc);
    const undo = undoManager(doc);
    expect(api.commitVideoSceneAnalysis(doc, hostId, completedScene())).toBe('applied');
    undo.undo();
    merge(doc, peer);
    expect(api.commitVideoSceneAnalysis(peer, hostId, completedScene())).toBe('ignored');
    expect(api.readVideoToolDraft(peer, hostId, 'video.split')).toEqual({ state: 'supported', draft: splitDraft({ cuts: [] }) });
  });

  it.each(['changed node content', 'missing reference', 'locked node', 'unavailable artifacts', 'failed analysis'] as const)('does not apply stale or unavailable scene results: %s', (condition) => {
    const doc = sceneSpace();
    const record = completedScene();
    if (condition === 'changed node content') dataOf(doc).set('content', 'https://media.example.test/replaced.mp4');
    if (condition === 'missing reference') dataOf(doc).delete(`miniToolAnalysis:${firstRunId}`);
    if (condition === 'locked node') dataOf(doc).set('locked', true);
    if (condition === 'unavailable artifacts') record.artifactUnavailable = true;
    if (condition === 'failed analysis') { record.status = 'failed'; record.result = null; record.error = { code: 'analysis_failed' }; }
    const undo = undoManager(doc);
    expect(api.commitVideoSceneAnalysis(doc, hostId, record)).toBe('ignored');
    expect(api.readVideoToolDraft(doc, hostId, 'video.split')).toEqual({ state: 'supported', draft: splitDraft({ cuts: [] }) });
    expect(undo.undoStack).toHaveLength(0);
  });
});

// frames-split §7.13 Dv: the draft's presentationRef is written with its parameters, a draft whose ref is not the selected
// version's reads stale, and Rebind binds it to the selected version as a new draft.
describe('a draft bound to a selected version (frames-split §7.13 Dv)', () => {
  const before: PresentationRef = { source: { toolInputId: 'a'.repeat(64), planSha256: 'b'.repeat(64) } };
  const after: PresentationRef = { source: { toolInputId: 'c'.repeat(64), planSha256: 'd'.repeat(64) } };

  it('commits the presentationRef with the parameters in the same revision and one undo step', () => {
    const { doc } = space();
    const undo = undoManager(doc);
    const draft = splitDraft({ cuts: [30] }, { presentationRef: before });
    expect(api.commitVideoToolDraft(doc, hostId, 'video.split', draft)).toBe(true);
    expect(dataOf(doc).get('miniToolDraft:video.split')).toEqual(draft);
    expect(undo.undoStack).toHaveLength(1);
    expect(api.readVideoToolDraft(doc, hostId, 'video.split', before)).toEqual({ state: 'supported', draft });
  });

  it('reads a draft set on another version as stale and keeps its values', () => {
    const { doc } = space();
    const draft = splitDraft({ cuts: [30] }, { presentationRef: before });
    api.commitVideoToolDraft(doc, hostId, 'video.split', draft);
    expect(api.readVideoToolDraft(doc, hostId, 'video.split', after)).toEqual({ state: 'stale', draft });
    expect(dataOf(doc).get('miniToolDraft:video.split')).toEqual(draft);
  });

  it('reads a saved draft without a presentationRef as stale', () => {
    const { doc } = space();
    const draft = splitDraft({ cuts: [30] });
    api.commitVideoToolDraft(doc, hostId, 'video.split', draft);
    expect(api.readVideoToolDraft(doc, hostId, 'video.split', after)).toEqual({ state: 'stale', draft });
  });

  it('rebinds a stale draft it still holds to the selected version as a new draft, dropping its analysis references, in one undo step', () => {
    const { doc } = space();
    const draft = splitDraft({ cuts: [30] }, { presentationRef: before });
    api.commitVideoToolDraft(doc, hostId, 'video.split', draft);
    api.commitVideoToolAnalysisRef(doc, hostId, analysisRef());
    const undo = undoManager(doc);
    expect(api.rebindVideoToolDraft(doc, hostId, 'video.split', after, secondRevision)).toBe(false);
    expect(undo.undoStack).toHaveLength(0);
    expect(api.rebindVideoToolDraft(doc, hostId, 'video.split', after, firstRevision)).toBe(true);
    const reading = api.readVideoToolDraft(doc, hostId, 'video.split', after);
    expect(reading).toMatchObject({ state: 'supported', draft: { params: { cuts: [30] }, source: draft.source, presentationRef: after } });
    if (reading.state !== 'supported') throw new Error('Expected a current draft');
    expect(reading.draft.draftId).not.toBe(draftId);
    expect(reading.draft.revision).not.toBe(firstRevision);
    expect(dataOf(doc).has(`miniToolAnalysis:${firstRunId}`)).toBe(false);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(api.readVideoToolDraft(doc, hostId, 'video.split', after)).toEqual({ state: 'stale', draft });
    expect(dataOf(doc).has(`miniToolAnalysis:${firstRunId}`)).toBe(true);
  });

  it('rebinds nothing when the host or its draft is missing', () => {
    const { doc } = space();
    expect(api.rebindVideoToolDraft(doc, hostId, 'video.split', after, firstRevision)).toBe(false);
    expect(api.rebindVideoToolDraft(doc, '10000000-0000-4000-8000-000000000099', 'video.split', after, firstRevision)).toBe(false);
  });
});
