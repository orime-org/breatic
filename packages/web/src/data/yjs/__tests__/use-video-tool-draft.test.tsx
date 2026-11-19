// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as Y from 'yjs';

import { addNode, CANVAS_UNDO, nodeDataMap } from '../canvas-space';
import { _resetForTests, destroyDoc, docName, getDoc } from '../manager';

interface Draft {
  version: 1;
  draftId: string;
  revision: string;
  source: { nodeId: string; canonicalURL: string; mediaInfo: { width: number; height: number; duration: number; mimeType: string } };
  params: { cuts: number[]; sensitivity: number };
  inputs: [];
}

type Reading =
  | { state: 'absent' }
  | { state: 'supported'; draft: Draft }
  | { state: 'unsupported'; value: unknown }
  | { state: 'invalid'; value: unknown };

interface HookApi {
  useVideoToolDraft: (projectId: string, spaceId: string, nodeId: string, toolId: 'video.split') => Reading;
}

const candidates = import.meta.glob('../use-video-tool-draft.ts');
let api: HookApi;
let counter = 0;
const hostId = '10000000-0000-4000-8000-000000000001';
const otherHostId = '10000000-0000-4000-8000-000000000002';
const key = 'miniToolDraft:video.split';
const sourceURL = 'https://media.example.test/source.mp4';

/** Creates the complete approved draft fixture. */
function draft(cuts: number[] = [1], revision = '30000000-0000-4000-8000-000000000001', nodeId = hostId): Draft {
  return {
    version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision,
    source: { nodeId, canonicalURL: sourceURL, mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } },
    params: { cuts, sensitivity: 0.4 }, inputs: [],
  };
}

/** Seeds the actual managed node observed by the hook. */
function addHost(projectId: string, spaceId: string, nodeId = hostId): void {
  addNode(projectId, spaceId, {
    id: nodeId, type: 'video', position: { x: 0, y: 0 },
    data: { name: 'Draft hook source', createdAt: 0, createdBy: 'video-draft-hook-test', locked: false, attachments: [], content: sourceURL },
  });
}

/** Opens a fresh managed document and raw video host. */
function space(): { projectId: string; spaceId: string; doc: Y.Doc } {
  counter += 1;
  const projectId = `video-draft-hook-project-${counter}`;
  const spaceId = `video-draft-hook-space-${counter}`;
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addHost(projectId, spaceId);
  return { projectId, spaceId, doc };
}

/** Writes one accepted full snapshot through a real Yjs transaction. */
function write(doc: Y.Doc, value: unknown, nodeId = hostId): void {
  const data = nodeDataMap(doc, nodeId);
  if (data === null) throw new Error('Missing hook fixture host');
  doc.transact(() => data.set(key, value), CANVAS_UNDO);
}

beforeAll(async () => {
  const load = candidates['../use-video-tool-draft.ts'];
  api = (load === undefined ? {} : await load()) as HookApi;
});

beforeEach(() => {
  _resetForTests();
});

afterEach(() => {
  cleanup();
  _resetForTests();
});

describe('video mini-tool draft subscription', () => {
  it('exports its draft hook entry point', () => {
    expect(['useVideoToolDraft'].filter((name) => !(name in api))).toEqual([]);
  });

  it('reads the current persisted value immediately on attachment', () => {
    const { projectId, spaceId, doc } = space();
    const saved = draft([2]);
    write(doc, saved);
    const { result } = renderHook(() => api.useVideoToolDraft(projectId, spaceId, hostId, 'video.split'));
    expect(result.current).toEqual({ state: 'supported', draft: saved });
  });

  it('follows full snapshot changes, draft removal and restoration', () => {
    const { projectId, spaceId, doc } = space();
    const { result } = renderHook(() => api.useVideoToolDraft(projectId, spaceId, hostId, 'video.split'));
    expect(result.current).toEqual({ state: 'absent' });
    const saved = draft();
    act(() => write(doc, saved));
    expect(result.current).toEqual({ state: 'supported', draft: saved });
    const changed = draft([2], '30000000-0000-4000-8000-000000000002');
    act(() => write(doc, changed));
    expect(result.current).toEqual({ state: 'supported', draft: changed });
    act(() => {
      doc.transact(() => nodeDataMap(doc, hostId)?.delete(key), CANVAS_UNDO);
    });
    expect(result.current).toEqual({ state: 'absent' });
    act(() => write(doc, saved));
    expect(result.current).toEqual({ state: 'supported', draft: saved });
  });

  it('reattaches after unmount with the latest value from the retained document', () => {
    const { projectId, spaceId, doc } = space();
    const initial = draft();
    write(doc, initial);
    const first = renderHook(() => api.useVideoToolDraft(projectId, spaceId, hostId, 'video.split'));
    expect(first.result.current).toEqual({ state: 'supported', draft: initial });
    first.unmount();
    const savedWhileHidden = draft([3], '30000000-0000-4000-8000-000000000003');
    write(doc, savedWhileHidden);
    const second = renderHook(() => api.useVideoToolDraft(projectId, spaceId, hostId, 'video.split'));
    expect(second.result.current).toEqual({ state: 'supported', draft: savedWhileHidden });
  });

  it('switches hosts without accepting subsequent updates from the old host', () => {
    const { projectId, spaceId, doc } = space();
    addHost(projectId, spaceId, otherHostId);
    const first = draft();
    const second = draft([2], '30000000-0000-4000-8000-000000000002', otherHostId);
    write(doc, first);
    write(doc, second, otherHostId);
    const { result, rerender } = renderHook(({ nodeId }) => api.useVideoToolDraft(projectId, spaceId, nodeId, 'video.split'), { initialProps: { nodeId: hostId } });
    expect(result.current).toEqual({ state: 'supported', draft: first });
    rerender({ nodeId: otherHostId });
    expect(result.current).toEqual({ state: 'supported', draft: second });
    act(() => write(doc, draft([4], '30000000-0000-4000-8000-000000000004')));
    expect(result.current).toEqual({ state: 'supported', draft: second });
  });

  it('rebinds to a recreated document and preserves its projection when the old document changes', () => {
    const { projectId, spaceId, doc: oldDoc } = space();
    const oldData = nodeDataMap(oldDoc, hostId);
    if (oldData === null) throw new Error('Missing original fixture node');
    write(oldDoc, draft());
    const first = renderHook(() => api.useVideoToolDraft(projectId, spaceId, hostId, 'video.split'));
    first.unmount();
    destroyDoc(docName.canvasSpace(projectId, spaceId));
    const nextDoc = getDoc(docName.canvasSpace(projectId, spaceId));
    addHost(projectId, spaceId);
    const current = draft([2], '30000000-0000-4000-8000-000000000002');
    write(nextDoc, current);
    const second = renderHook(() => api.useVideoToolDraft(projectId, spaceId, hostId, 'video.split'));
    expect(second.result.current).toEqual({ state: 'supported', draft: current });
    act(() => {
      oldDoc.transact(() => oldData.set(key, draft([4], '30000000-0000-4000-8000-000000000004')), CANVAS_UNDO);
    });
    expect(second.result.current).toEqual({ state: 'supported', draft: current });
  });

  it('retains the persisted projection through StrictMode attachment and cleanup', () => {
    const { projectId, spaceId, doc } = space();
    const saved = draft([2]);
    write(doc, saved);
    const { result } = renderHook(() => api.useVideoToolDraft(projectId, spaceId, hostId, 'video.split'), {
      wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
    });
    expect(result.current).toEqual({ state: 'supported', draft: saved });
    const changed = draft([3], '30000000-0000-4000-8000-000000000003');
    act(() => write(doc, changed));
    expect(result.current).toEqual({ state: 'supported', draft: changed });
  });

  it.each([
    { state: 'unsupported', value: { ...draft(), version: 2 } },
    { state: 'invalid', value: { version: 1, params: { cuts: [2] } } },
  ])('exposes $state data without replacing the stored snapshot', ({ state, value }) => {
    const { projectId, spaceId, doc } = space();
    write(doc, value);
    const { result } = renderHook(() => api.useVideoToolDraft(projectId, spaceId, hostId, 'video.split'));
    expect(result.current).toEqual({ state, value });
    expect(nodeDataMap(doc, hostId)?.get(key)).toEqual(value);
  });
});
