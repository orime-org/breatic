// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec 9.1b
 * (TU-01 to TU-10): a background Timeline upload that finishes while the
 * Space is full, over its ceiling or being rebuilt is not converted. The
 * record stays done, the placeholder stays and shows the shared waiting
 * sentence (`spaces.sizeCap.wait`, not while rebuilding), and the controller
 * converts it exactly once after the Space has room again, as the Document's
 * pending blocks do.
 *
 * The network and the provider are faked at their module boundaries; the
 * size state, the document cache, the provider registry and the controller
 * are real.
 */

import * as React from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { t, type TimelineClip } from '@breatic/shared';
import type * as MediaUploadModule from '@web/data/upload/media-upload';
import type * as TimelineApiModule from '@web/data/api/timeline';

const { toast, uploadMedia, resolveAsset } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  uploadMedia: vi.fn(),
  resolveAsset: vi.fn(),
}));
vi.mock('@web/lib/toast', () => ({ toast, muteToasts: vi.fn(), _unmuteToastsForTests: vi.fn() }));
vi.mock('@hocuspocus/provider', async () => {
  const { Awareness: RealAwareness } = await import('y-protocols/awareness');
  /** A provider with the fields the registry reads and an event emitter the test drives. */
  class FakeProvider {
    awareness: Awareness;
    document: Y.Doc;
    isAuthenticated = true;
    authorizedScope = 'read-write';
    private readonly listeners = new Map<string, Set<(data?: unknown) => void>>();
    /**
     * Bind the fake to its document.
     * @param config - The provider options.
     * @param config.document - The document.
     */
    constructor(config: { document: Y.Doc }) {
      this.document = config.document;
      this.awareness = new RealAwareness(config.document);
    }
    /**
     * Listen for an event.
     * @param event - The event.
     * @param listener - The listener.
     */
    on(event: string, listener: (data?: unknown) => void): void {
      const set = this.listeners.get(event) ?? new Set();
      set.add(listener);
      this.listeners.set(event, set);
    }
    /**
     * Stop listening.
     * @param event - The event.
     * @param listener - The listener.
     */
    off(event: string, listener: (data?: unknown) => void): void {
      this.listeners.get(event)?.delete(listener);
    }
    /**
     * Fire an event as the server's answer would.
     * @param event - The event.
     * @param data - Its payload.
     */
    emit(event: string, data?: unknown): void {
      [...(this.listeners.get(event) ?? [])].forEach((listener) => listener(data));
    }
    /** Nothing to attach in a test. */
    attach(): void {}
    /** Release the awareness. */
    destroy(): void { this.awareness.destroy(); }
  }
  return {
    HocuspocusProviderWebsocket: class { on(): void {} destroy(): void {} },
    HocuspocusProvider: FakeProvider,
  };
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaUploadModule>()),
  uploadMedia,
}));
vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, resolveAsset } };
});

import type { StoredUpload } from '@web/data/upload/media-upload';
import { _resetCollabSocketForTests, acquireDocProvider } from '@web/data/yjs/collab-socket';
import { clearAllDocSizes, docSizeSynced, startDocResync } from '@web/data/yjs/doc-size';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { readTimelineDocument } from '@web/data/yjs/timeline-document';
import { evictTimelineUploads, getTimelineUploads, type TimelineUploads } from '@web/spaces/timeline/timeline-uploads';
import { timelineUploadText, timelineUploadView, useTimelineUploadViews } from '@web/spaces/timeline/use-timeline-upload-views';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { MAIN, V2, cid, seededDoc, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { ASSET_ID, UPLOAD_ID, registeredVideo, uploadClip } from '@web/data/yjs/__tests__/timeline-upload-fixtures';
import { P_FULL, P_NORMAL, P_WARNING, SIZE_COPY_EN, SIZE_COPY_ZH_CN, enterSize, pushSize } from '@web/data/yjs/__tests__/helpers/size-v2-harness';

/** What the fake provider exposes to the test. */
interface FakeProvider {
  authorizedScope: string;
  emit: (event: string, data?: unknown) => void;
}

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const NAME = docName.timelineSpace(PROJECT, SPACE);
const TRACKS = [track(MAIN, 0), track(V2, 1)];
const FILE = new File([new Uint8Array(8)], 'beach.mp4', { type: 'video/mp4' });
const STORED: StoredUpload = { assetId: ASSET_ID, fileUrl: 'https://cdn.example/beach.mp4', kind: 'video', width: 1920, height: 1080 };
const P1 = cid(1);

/** The running fake uploads, resolved by the test. */
const pending: Array<(stored: StoredUpload) => void> = [];

/**
 * Let queued microtasks and timers run.
 * @returns Once they have.
 */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Open the Timeline document with one upload placeholder `p1` of `UPLOAD_ID`,
 * optionally with a provider, and its upload controller.
 * @param withProvider - Register a fake provider for the document.
 * @returns The document, the provider (or null) and the controller.
 * @throws {Error} When the fixture is invalid.
 */
function open(withProvider = false): { doc: Y.Doc; provider: FakeProvider | null; uploads: TimelineUploads } {
  const doc = getDoc(NAME);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seededDoc(timeline([uploadClip(P1, V2, 0)], TRACKS, []))), 'remote');
  const provider = withProvider ? acquireDocProvider(NAME, doc) as unknown as FakeProvider : null;
  const uploads = getTimelineUploads(doc, NAME, { projectId: PROJECT, spaceId: SPACE });
  return { doc, provider, uploads };
}

/**
 * Start the upload of `p1` and let it finish.
 * @param uploads - The controller.
 * @returns Once the record is done and the scan that follows ran.
 */
async function finish(uploads: TimelineUploads): Promise<void> {
  uploads.start(UPLOAD_ID, FILE);
  pending.shift()?.(STORED);
  await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'done' }));
  await settle();
}

/**
 * The kind of `p1` in the document.
 * @param doc - The document.
 * @returns Its kind, or undefined when it is gone.
 */
function kindOfP1(doc: Y.Doc): string | undefined {
  return readTimelineDocument(doc).clips[P1]?.kind;
}

/**
 * How many source records the document holds.
 * @param doc - The document.
 * @returns The count.
 */
function sourceCount(doc: Y.Doc): number {
  return Object.keys(readTimelineDocument(doc).sources).length;
}

/**
 * What `p1` shows, read through `useTimelineUploadViews` as the track and the
 * properties panel read it.
 * @param doc - The document.
 * @param uploads - The controller.
 * @returns The view.
 * @throws {Error} When `p1` has no view.
 */
function viewOfP1(doc: Y.Doc, uploads: TimelineUploads): ReturnType<typeof timelineUploadView> {
  const clips = Object.values(readTimelineDocument(doc).clips) as TimelineClip[];
  const { result, unmount } = renderHook(() => useTimelineUploadViews(NAME, uploads, clips));
  const view = result.current.get(P1);
  unmount();
  if (view === undefined) throw new Error('p1 has no view');
  return view;
}

/**
 * Collects every local update the document emits from now on.
 * @param doc - The document.
 * @returns The list, filled as updates arrive.
 */
function localUpdates(doc: Y.Doc): Uint8Array[] {
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') updates.push(update); });
  return updates;
}

beforeEach(async () => {
  await changeLocale('en');
  _resetCollabSocketForTests();
  _resetForTests();
  useSpaceOperationsStore.setState({ operations: {} });
  pending.splice(0);
  vi.clearAllMocks();
  uploadMedia.mockImplementation(() => new Promise<StoredUpload>((resolve) => { pending.push(resolve); }));
  resolveAsset.mockResolvedValue(registeredVideo(5));
});

afterEach(() => {
  evictTimelineUploads(NAME);
  clearAllDocSizes();
  _resetCollabSocketForTests();
  _resetForTests();
});

describe('TU-01 to TU-04 an upload that finishes while the Space has no room', () => {
  it('TU-01 at F keeps the placeholder, keeps the record done, toasts nothing and shows the waiting sentence', async () => {
    const { doc, uploads } = open();
    enterSize(NAME, 'W');
    uploads.start(UPLOAD_ID, FILE);
    pushSize(NAME, P_FULL);
    const sources = sourceCount(doc);
    const before = Y.encodeStateAsUpdate(doc);
    pending.shift()?.(STORED);
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'done' }));
    await settle();

    expect(kindOfP1(doc)).toBe('upload');
    expect(sourceCount(doc)).toBe(sources);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    const view = viewOfP1(doc, uploads);
    expect(view).toEqual({ state: 'waitingFull', progress: null, reason: null, retryable: false });
    expect(timelineUploadText(t, view, 'beach.mp4')).toBe(SIZE_COPY_EN.T_WAIT);
  });

  it('TU-02 converts exactly once after the Space drops to warning, and not again on later pushes or edits', async () => {
    const { doc, uploads } = open();
    enterSize(NAME, 'F');
    await finish(uploads);
    const sources = sourceCount(doc);
    expect(kindOfP1(doc)).toBe('upload');

    pushSize(NAME, P_WARNING);
    await vi.waitFor(() => expect(kindOfP1(doc)).toBe('video'));
    expect(sourceCount(doc)).toBe(sources + 1);
    const clip = readTimelineDocument(doc).clips[P1];
    const source = clip?.kind === 'video' ? readTimelineDocument(doc).sources[clip.sourceId] : undefined;
    expect(source).toMatchObject({ kind: 'video', assetId: ASSET_ID });

    const updates = localUpdates(doc);
    pushSize(NAME, P_NORMAL);
    await settle();
    doc.transact(() => { (doc.getMap('clips').get(P1) as Y.Map<unknown>).set('startFrame', 5); }, 'remote');
    await settle();
    expect(sourceCount(doc)).toBe(sources + 1);
    expect(updates).toEqual([]);
  });

  it('TU-03 over the ceiling waits the same way and converts once back at warning', async () => {
    const { doc, uploads } = open();
    enterSize(NAME, 'O');
    await finish(uploads);
    expect(kindOfP1(doc)).toBe('upload');
    expect(toast.warning).not.toHaveBeenCalled();
    expect(viewOfP1(doc, uploads).state).toBe('waitingFull');
    expect(timelineUploadText(t, viewOfP1(doc, uploads), 'beach.mp4')).toBe(SIZE_COPY_EN.T_WAIT);

    pushSize(NAME, P_WARNING);
    await vi.waitFor(() => expect(kindOfP1(doc)).toBe('video'));
  });

  it('TU-04 while the document is rebuilt does not convert and shows uploading, then converts once after sync', async () => {
    const { doc, uploads } = open();
    enterSize(NAME, 'N');
    startDocResync(NAME);
    await finish(uploads);
    expect(kindOfP1(doc)).toBe('upload');
    expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'done' });
    expect(toast.warning).not.toHaveBeenCalled();
    const view = viewOfP1(doc, uploads);
    expect(view).toEqual({ state: 'uploading', progress: null, reason: null, retryable: false });
    expect(timelineUploadText(t, view, 'beach.mp4')).toBe(t('timeline.upload.uploading'));

    docSizeSynced(NAME);
    pushSize(NAME, P_WARNING);
    await vi.waitFor(() => expect(kindOfP1(doc)).toBe('video'));
  });
});

describe('TU-05 the conversion is an add judged without a toast', () => {
  it('TU-05 writes a new source at U, and is refused with no toast at F, O and Z', async () => {
    for (const code of ['F', 'O', 'Z'] as const) {
      const { doc, uploads } = open();
      enterSize(NAME, code);
      const before = Y.encodeStateAsUpdate(doc);
      await finish(uploads);
      expect(Y.encodeStateAsUpdate(doc), code).toEqual(before);
      expect(toast.warning, code).not.toHaveBeenCalled();
      evictTimelineUploads(NAME);
      clearAllDocSizes();
      _resetForTests();
    }
    const { doc, uploads } = open();
    const sources = sourceCount(doc);
    const updates = localUpdates(doc);
    await finish(uploads);
    expect(kindOfP1(doc)).toBe('video');
    expect(sourceCount(doc)).toBe(sources + 1);
    expect(updates.length).toBeGreaterThan(0);
    // The write adds structs (a new source record): not a pure delete.
    for (const update of updates) expect(Y.decodeUpdate(update).structs.length).toBeGreaterThan(0);
  });
});

describe('TU-06 and TU-07 what the size check leaves as it was', () => {
  it('TU-06 without write access shows waiting, at F too, and converts once access returns at N', async () => {
    for (const code of ['F', 'N'] as const) {
      const { doc, provider, uploads } = open(true);
      enterSize(NAME, code);
      provider!.authorizedScope = 'readonly';
      provider!.emit('authenticated');
      await finish(uploads);
      expect(kindOfP1(doc), code).toBe('upload');
      const view = viewOfP1(doc, uploads);
      expect(view.state, code).toBe('waiting');
      expect(timelineUploadText(t, view, 'beach.mp4'), code).toBe(t('timeline.upload.waiting'));
      if (code === 'N') {
        provider!.authorizedScope = 'read-write';
        provider!.emit('authenticated');
        await vi.waitFor(() => expect(kindOfP1(doc)).toBe('video'));
      }
      evictTimelineUploads(NAME);
      clearAllDocSizes();
      _resetCollabSocketForTests();
      _resetForTests();
    }
  });

  it('TU-07 stops following the size once the controller is gone', async () => {
    const { doc, uploads } = open();
    enterSize(NAME, 'F');
    await finish(uploads);
    const before = Y.encodeStateAsUpdate(doc);
    evictTimelineUploads(NAME);
    pushSize(NAME, P_WARNING);
    await settle();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(kindOfP1(doc)).toBe('upload');
  });
});

describe('TU-08 to TU-10 what the placeholder shows', () => {
  it('TU-08 the views read again when only the size changes: waitingFull, uploading while rebuilt, waitingFull', async () => {
    const { doc, uploads } = open();
    enterSize(NAME, 'F');
    await finish(uploads);
    const clips = Object.values(readTimelineDocument(doc).clips) as TimelineClip[];
    /**
     * The state of `p1`.
     * @returns Its text.
     */
    function View(): React.JSX.Element {
      const view = useTimelineUploadViews(NAME, uploads, clips).get(P1);
      return <span data-testid='view'>{`${view?.state}:${String(view?.progress)}`}</span>;
    }
    const screen = render(<View />);
    expect(screen.getByTestId('view').textContent).toBe('waitingFull:null');
    act(() => { startDocResync(NAME); });
    expect(screen.getByTestId('view').textContent).toBe('uploading:null');
    act(() => {
      docSizeSynced(NAME);
      pushSize(NAME, P_FULL);
    });
    expect(screen.getByTestId('view').textContent).toBe('waitingFull:null');
    screen.unmount();
  });

  const asset = { assetId: 'asset-1' } as never;
  it.each([
    ['a finished upload with write access on a full Space', { phase: 'done', asset }, 'granted', null, true, { state: 'waitingFull', progress: null, reason: null, retryable: false }],
    ['a finished upload without write access on a full Space', { phase: 'done', asset }, 'denied', null, true, { state: 'waiting', progress: null, reason: null, retryable: false }],
    ['a finished upload with write access on a Space with room', { phase: 'done', asset }, 'granted', null, false, { state: 'uploading', progress: null, reason: null, retryable: false }],
    ['a running upload on a full Space', { phase: 'uploading', progress: 0.4 }, 'granted', null, true, { state: 'uploading', progress: 0.4, reason: null, retryable: false }],
    ['a failed upload on a full Space', { phase: 'failed', reason: 'upload', retryable: true }, 'granted', null, true, { state: 'failed', progress: null, reason: 'upload', retryable: true }],
    ['a collaborator\'s upload on a full Space', undefined, 'granted', 'uploading', true, { state: 'uploading', progress: null, reason: null, retryable: false }],
    ['an unclaimed placeholder on a full Space', undefined, 'granted', null, true, { state: 'unfinished', progress: null, reason: null, retryable: false }],
  ] as const)('TU-09 shows %s', (_case, entry, access, claim, full, expected) => {
    expect(timelineUploadView(entry, access, claim, full)).toEqual(expected);
  });

  it('TU-10 the waiting state reads the shared sentence in en and zh-CN', async () => {
    const view = { state: 'waitingFull', progress: null, reason: null, retryable: false } as const;
    expect(timelineUploadText(t, view, 'clip.mp4')).toBe(SIZE_COPY_EN.T_WAIT);
    await changeLocale('zh-CN');
    expect(timelineUploadText(t, view, 'clip.mp4')).toBe(SIZE_COPY_ZH_CN.T_WAIT);
    await changeLocale('en');
  });
});
