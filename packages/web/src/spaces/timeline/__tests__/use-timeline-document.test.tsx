// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import {
  applyTimelineEdit,
  initializeTimelineDocument,
  type TimelineDocumentV1,
  type TimelineVideoClip,
  type TimelineVideoSource,
} from '@breatic/shared';

import { useTimelineDocument } from '@web/spaces/timeline/use-timeline-document';

const SETTINGS = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000001',
  kind: 'video',
  assetId: '20000000-0000-4000-8000-000000000001',
  timebase: SETTINGS.fps,
  extentFrames: 48,
  durationSeconds: '2',
  durationOrigin: 'registered',
};
const CLIP: TimelineVideoClip = {
  id: '30000000-0000-4000-8000-000000000001',
  kind: 'video', trackId: 'visual-1', sourceId: SOURCE.id,
  startFrame: 0, sourceInFrame: 0, durationFrames: 48,
  rate: { num: 1, den: 1 }, gain: 1, mute: false,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};
const EMPTY: TimelineDocumentV1 = {
  schemaVersion: 1,
  settings: SETTINGS,
  tracks: { 'visual-1': { id: 'visual-1', kind: 'visual', order: 0 } },
  clips: {}, sources: {},
};
const docs: Y.Doc[] = [];

/**
 * Track a real collaborative document for cleanup after hook subscribers leave.
 * @param update - The server or peer snapshot to apply before rendering.
 * @returns The actual Yjs document used by the hook.
 * @throws {Error} When an encoded update is invalid.
 */
function makeDoc(update?: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  if (update !== undefined) Y.applyUpdate(doc, update, 'server');
  return doc;
}

/**
 * Construct the server-owned initial state with explicitly fixed settings.
 * @returns A real initialized Timeline document.
 * @throws {Error} When the shared seed rejects the test settings.
 */
function seededDoc(): Y.Doc {
  const doc = makeDoc();
  initializeTimelineDocument(doc, SETTINGS);
  return doc;
}

/**
 * Add the independently specified registered-video fixture as one transaction.
 * @param doc - The seeded collaborative document to edit.
 * @throws {Error} When the test edit is refused.
 */
function addVideo(doc: Y.Doc): void {
  expect(applyTimelineEdit(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP } })).toBe(true);
}

/**
 * Exercise React's effect replay using the actual hook and document.
 * @param props - The hook renderer's children.
 * @returns The StrictMode wrapper.
 * @throws {never} Never.
 */
function StrictWrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <React.StrictMode>{children}</React.StrictMode>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const doc of docs.splice(0)) doc.destroy();
});

describe('useTimelineDocument content ownership', () => {
  it('keeps a disabled empty document untouched until its content arrives', () => {
    const doc = makeDoc();
    const before = Y.encodeStateAsUpdate(doc);
    const { result } = renderHook(() => useTimelineDocument(doc, false));
    expect(result.current).toEqual({ document: null, error: null });
    expect([...doc.share.keys()]).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('returns no projection for a disabled document that already holds content', () => {
    const doc = seededDoc();
    const { result } = renderHook(() => useTimelineDocument(doc, false));
    expect(result.current).toEqual({ document: null, error: null });
  });

  it('reads the persisted server seed without writing collaborative content', () => {
    const server = seededDoc();
    const bytes = Y.encodeStateAsUpdate(server);
    const client = makeDoc(bytes);
    const observedUpdate = vi.fn();
    client.on('update', observedUpdate);
    const { result } = renderHook(() => useTimelineDocument(client, true));
    expect(result.current).toEqual({ document: EMPTY, error: null });
    expect(Y.encodeStateAsUpdate(client)).toEqual(bytes);
    expect(observedUpdate).toHaveBeenCalledTimes(0);
  });

  it('reads content received while disabled when the initial-sync gate opens', () => {
    const server = seededDoc();
    const client = makeDoc();
    const { result, rerender } = renderHook(({ enabled }) => useTimelineDocument(client, enabled), { initialProps: { enabled: false } });
    act(() => Y.applyUpdate(client, Y.encodeStateAsUpdate(server), 'provider'));
    expect(result.current).toEqual({ document: null, error: null });
    rerender({ enabled: true });
    expect(result.current).toEqual({ document: EMPTY, error: null });
  });

  it('reports an enabled empty document and preserves its absent roots', () => {
    const doc = makeDoc();
    const before = Y.encodeStateAsUpdate(doc);
    const { result } = renderHook(() => useTimelineDocument(doc, true));
    expect(result.current.document).toBe(null);
    expect(result.current.error).toBeInstanceOf(Error);
    expect([...doc.share.keys()]).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each([0, 2, '1', null])('preserves unknown version %s and its existing root set', (version) => {
    const doc = makeDoc();
    doc.getMap('timeline').set('schemaVersion', version);
    const before = Y.encodeStateAsUpdate(doc);
    const keys = [...doc.share.keys()];
    const { result } = renderHook(() => useTimelineDocument(doc, true));
    expect(result.current.document).toBe(null);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect([...doc.share.keys()]).toEqual(keys);
  });

  it('reports malformed creation settings and preserves the stored bytes', () => {
    const doc = seededDoc();
    doc.getMap('timeline').set('settings', { ...SETTINGS, fps: { num: 24, den: 0 } });
    const before = Y.encodeStateAsUpdate(doc);
    const { result } = renderHook(() => useTimelineDocument(doc, true));
    expect(result.current.document).toBe(null);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('recovers from an unavailable projection when valid server content arrives', () => {
    const client = makeDoc();
    const server = seededDoc();
    const { result } = renderHook(() => useTimelineDocument(client, true));
    expect(result.current.error).toBeInstanceOf(Error);
    act(() => Y.applyUpdate(client, Y.encodeStateAsUpdate(server), 'provider'));
    expect(result.current).toEqual({ document: EMPTY, error: null });
  });

  it('publishes the source and clip from a local atomic addition together', () => {
    const doc = seededDoc();
    const { result } = renderHook(() => useTimelineDocument(doc, true));
    const initial = result.current.document;
    act(() => addVideo(doc));
    expect(result.current).toEqual({
      document: { ...EMPTY, sources: { [SOURCE.id]: SOURCE }, clips: { [CLIP.id]: CLIP } },
      error: null,
    });
    expect(initial).toEqual(EMPTY);
  });

  it('projects a peer addition received through the existing Yjs update path', () => {
    const server = seededDoc();
    const seed = Y.encodeStateAsUpdate(server);
    const peer = makeDoc(seed);
    const client = makeDoc(seed);
    const { result } = renderHook(() => useTimelineDocument(client, true));
    const vector = Y.encodeStateVector(client);
    addVideo(peer);
    act(() => Y.applyUpdate(client, Y.encodeStateAsUpdate(peer, vector), 'remote-provider'));
    expect(result.current).toEqual({
      document: { ...EMPTY, sources: { [SOURCE.id]: SOURCE }, clips: { [CLIP.id]: CLIP } },
      error: null,
    });
  });

  it('projects nested clip fields after a peer changes the start frame', () => {
    const server = seededDoc();
    addVideo(server);
    const bytes = Y.encodeStateAsUpdate(server);
    const peer = makeDoc(bytes);
    const client = makeDoc(bytes);
    const { result } = renderHook(() => useTimelineDocument(client, true));
    const original = result.current.document;
    const vector = Y.encodeStateVector(client);
    expect(applyTimelineEdit(peer, { operation: 'set_start', parameters: { clipId: CLIP.id, startFrame: 72 } })).toBe(true);
    act(() => Y.applyUpdate(client, Y.encodeStateAsUpdate(peer, vector), 'remote-provider'));
    expect(result.current.document?.clips[CLIP.id]).toEqual({ ...CLIP, startFrame: 72 });
    expect(original?.clips[CLIP.id]).toEqual(CLIP);
    expect(result.current.error).toBe(null);
  });

  it('clears an existing projection when a later update makes its schema invalid', () => {
    const doc = seededDoc();
    const { result } = renderHook(() => useTimelineDocument(doc, true));
    expect(result.current).toEqual({ document: EMPTY, error: null });
    act(() => doc.getMap('timeline').set('schemaVersion', 2));
    const before = Y.encodeStateAsUpdate(doc);
    expect(result.current.document).toBe(null);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe('useTimelineDocument subscription lifecycle', () => {
  it('clears the projection while disabled and reads the latest content on enable', () => {
    const doc = seededDoc();
    const { result, rerender } = renderHook(({ enabled }) => useTimelineDocument(doc, enabled), { initialProps: { enabled: true } });
    rerender({ enabled: false });
    expect(result.current).toEqual({ document: null, error: null });
    act(() => addVideo(doc));
    expect(result.current).toEqual({ document: null, error: null });
    rerender({ enabled: true });
    expect(result.current.document?.clips[CLIP.id]).toEqual(CLIP);
    expect(result.current.error).toBe(null);
  });

  it('switches to the supplied document and leaves old-document changes isolated', () => {
    const first = seededDoc();
    addVideo(first);
    const second = seededDoc();
    const { result, rerender } = renderHook(({ doc }) => useTimelineDocument(doc, true), { initialProps: { doc: first } });
    expect(result.current.document?.clips[CLIP.id]).toEqual(CLIP);
    rerender({ doc: second });
    expect(result.current).toEqual({ document: EMPTY, error: null });
    act(() => first.getMap('timeline').set('schemaVersion', 2));
    expect(result.current).toEqual({ document: EMPTY, error: null });
    act(() => addVideo(second));
    expect(result.current.document?.clips[CLIP.id]).toEqual(CLIP);
  });

  it('balances every update subscription across StrictMode replay and unmount', () => {
    const doc = seededDoc();
    const on = vi.spyOn(doc, 'on');
    const off = vi.spyOn(doc, 'off');
    const setup = vi.fn();
    const release = vi.fn();
    const { result, unmount } = renderHook(() => {
      React.useEffect(() => {
        setup();
        return release;
      }, []);
      return useTimelineDocument(doc, true);
    }, { wrapper: StrictWrapper, reactStrictMode: true });
    expect(setup).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    act(() => addVideo(doc));
    expect(result.current.document?.clips[CLIP.id]).toEqual(CLIP);
    unmount();
    expect(release).toHaveBeenCalledTimes(2);
    const subscriptions = on.mock.calls.filter(([event]) => event === 'update').map(([, handler]) => handler);
    const releases = off.mock.calls.filter(([event]) => event === 'update').map(([, handler]) => handler);
    expect(subscriptions).toHaveLength(2);
    expect(releases).toHaveLength(subscriptions.length);
    for (const handler of subscriptions) expect(releases.filter((released) => released === handler)).toHaveLength(subscriptions.filter((subscribed) => subscribed === handler).length);
    expect(doc.isDestroyed).toBe(false);
  });

  it('releases update listeners when the initial-sync gate closes', () => {
    const doc = seededDoc();
    const on = vi.spyOn(doc, 'on');
    const off = vi.spyOn(doc, 'off');
    const { result, rerender } = renderHook(({ enabled }) => useTimelineDocument(doc, enabled), { initialProps: { enabled: true } });
    rerender({ enabled: false });
    const subscriptions = on.mock.calls.filter(([event]) => event === 'update').map(([, handler]) => handler);
    const releases = off.mock.calls.filter(([event]) => event === 'update').map(([, handler]) => handler);
    expect(subscriptions).toHaveLength(1);
    expect(releases).toHaveLength(subscriptions.length);
    for (const handler of subscriptions) expect(releases).toContain(handler);
    expect(result.current).toEqual({ document: null, error: null });
    expect(doc.isDestroyed).toBe(false);
  });

  it('projects integer-frame edits while preserving every read snapshot', () => {
    const doc = seededDoc();
    addVideo(doc);
    const { result } = renderHook(() => useTimelineDocument(doc, true));
    fc.assert(fc.property(fc.integer({ min: 0, max: 100_000 }), (startFrame) => {
      const previous = result.current.document;
      const previousStart = previous?.clips[CLIP.id]?.startFrame;
      act(() => {
        expect(applyTimelineEdit(doc, { operation: 'set_start', parameters: { clipId: CLIP.id, startFrame } })).toBe(true);
      });
      const beforeRead = Y.encodeStateAsUpdate(doc);
      expect(result.current.document?.clips[CLIP.id]).toEqual({ ...CLIP, startFrame });
      expect(previous?.clips[CLIP.id]?.startFrame).toBe(previousStart);
      expect(result.current.error).toBe(null);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeRead);
    }));
  });
});
