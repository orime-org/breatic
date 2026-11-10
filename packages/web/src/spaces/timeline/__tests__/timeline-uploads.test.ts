// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Timeline upload controller (#1434 design §3.1, §3.3).
 *
 * `getTimelineUploads(doc, name, { projectId, spaceId })` in `timeline-uploads.ts` is a document-scoped controller,
 * kept beside the edit session and the media draft, so hiding the Space tab does not stop it. `start(uploadId, file)`
 * uploads the file with `uploadMedia`, reads the registered asset with `timelineApi.resolveAsset`, and, whenever a
 * placeholder of a finished upload is in the document and this page may write, converts it with
 * `convertTimelineUpload`. `entry(uploadId)` says where the upload stands on this page: `{ phase: 'uploading',
 * progress }` (the share sent, 0 to 1, or null), `{ phase: 'done', asset }` or `{ phase: 'failed', reason, retryable }`.
 * While an upload is running and a placeholder of it is in the document, it is registered with
 * `useSpaceOperationsStore` (the tab spinner and the close guard); the page's awareness carries
 * `uploads: { [uploadId]: 'uploading' | 'failed' }` for collaborators. Write access and awareness come from the
 * document's provider in the collab-socket registry, re-read on `authenticated` and `authenticationFailed`.
 *
 * The network and the provider are faked at their module boundaries; the store, the edit session, the document
 * cache and the provider registry are real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { TimelineClipSchema, type ProjectRegisteredAsset } from '@breatic/shared';

import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { UploadFailedError, uploadMedia, type StoredUpload } from '@web/data/upload/media-upload';
import type * as MediaUploadModule from '@web/data/upload/media-upload';
import { _resetCollabSocketForTests, acquireDocProvider } from '@web/data/yjs/collab-socket';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { readTimelineDocument } from '@web/data/yjs/timeline-document';
import { evictTimelineEditSession, getTimelineEditSession, type TimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { evictTimelineUploads, getTimelineUploads, type TimelineUploads } from '@web/spaces/timeline/timeline-uploads';
import {
  MAIN, OFF, SOURCE, V2, V3, cid, clip, seededDoc, timeline, track,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  ASSET_ID, UPLOAD_ID, addUpload, clipRecords, registeredVideo, uploadClip,
} from '@web/data/yjs/__tests__/timeline-upload-fixtures';

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
vi.mock('@web/data/upload/media-upload', async (importOriginal) => {
  const actual = await importOriginal<typeof MediaUploadModule>();
  return { ...actual, uploadMedia: vi.fn() };
});
vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, resolveAsset: vi.fn() } };
});

/** What the fake provider exposes to the test. */
interface FakeProvider {
  awareness: Awareness;
  isAuthenticated: boolean;
  authorizedScope: string;
  emit: (event: string, data?: unknown) => void;
}

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const NAME = docName.timelineSpace(PROJECT, SPACE);
const TRACKS = [track(MAIN, 0), track(V2, 1), track(V3, 2)];
const FILE = new File([new Uint8Array(8)], 'beach.mp4', { type: 'video/mp4' });
const STORED: StoredUpload = { assetId: ASSET_ID, fileUrl: 'https://cdn.example/beach.mp4', kind: 'video', width: 1920, height: 1080 };

/** One running fake upload. */
interface Pending { file: File; progress: (share: number) => void; resolve: (stored: StoredUpload) => void; reject: (err: unknown) => void }
const pending: Pending[] = [];

/**
 * Let queued microtasks and timers run.
 * @returns Once they have.
 */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Open the Timeline document with its provider, its session and its upload controller.
 * @param clips - The clips it starts with.
 * @param onRegistered - Told once an upload registered as a video.
 * @returns The document, its provider, the session and the controller.
 * @throws {Error} When the fixture is invalid.
 */
function open(clips: Parameters<typeof timeline>[0], onRegistered?: () => void): { doc: Y.Doc; provider: FakeProvider; session: TimelineEditSession; uploads: TimelineUploads } {
  const doc = getDoc(NAME);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seededDoc(timeline(clips, TRACKS, [SOURCE]))));
  const provider = acquireDocProvider(NAME, doc) as unknown as FakeProvider;
  const session = getTimelineEditSession(doc, NAME);
  session.setCanWrite(true);
  const uploads = getTimelineUploads(doc, NAME, { projectId: PROJECT, spaceId: SPACE, ...(onRegistered === undefined ? {} : { onRegistered }) });
  return { doc, provider, session, uploads };
}

/**
 * The claims this page publishes.
 * @param provider - The provider.
 * @returns Its `uploads` awareness field.
 * @throws {never} Never.
 */
function claims(provider: FakeProvider): unknown {
  return (provider.awareness.getLocalState() as { uploads?: unknown } | null)?.uploads ?? {};
}

/**
 * Whether the Space is registered as busy.
 * @returns True while it is.
 * @throws {never} Never.
 */
function busy(): boolean {
  return useSpaceOperationsStore.getState().hasOperations(SPACE);
}

/**
 * The kind of a clip in the document.
 * @param doc - The document.
 * @param clipId - The clip.
 * @returns Its kind, or undefined when it is gone.
 * @throws {never} Never.
 */
function kindOf(doc: Y.Doc, clipId: string): string | undefined {
  return readTimelineDocument(doc).clips[clipId]?.kind;
}

beforeEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
  useSpaceOperationsStore.setState({ operations: {} });
  pending.splice(0);
  vi.mocked(uploadMedia).mockReset().mockImplementation((file, _context, onProgress) => new Promise<StoredUpload>((resolve, reject) => {
    pending.push({ file, progress: onProgress ?? ((): void => undefined), resolve, reject });
  }));
  vi.mocked(timelineApi.resolveAsset).mockReset().mockResolvedValue(registeredVideo(5));
});

afterEach(() => {
  evictTimelineUploads(NAME);
  evictTimelineEditSession(NAME);
  _resetCollabSocketForTests();
  _resetForTests();
});

describe('a background upload', () => {
  it('uploads the file to this Project and Space and reports its progress as a share', async () => {
    const { uploads } = open([uploadClip(cid(1), V2, 0)]);
    const listener = vi.fn();
    uploads.subscribe(listener);
    uploads.start(UPLOAD_ID, FILE);
    expect(vi.mocked(uploadMedia).mock.calls[0]?.slice(0, 2)).toEqual([FILE, { projectId: PROJECT, spaceId: SPACE }]);
    expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'uploading' });
    pending[0]?.progress(0.42);
    expect(uploads.entry(UPLOAD_ID)).toEqual({ phase: 'uploading', progress: 0.42 });
    expect(listener).toHaveBeenCalled();
  });

  it('converts every placeholder of the upload once it registers, without an undo step', async () => {
    const { doc, session, uploads } = open([uploadClip(cid(1), V2, 0, 30), uploadClip(cid(2), V2, 30, 30, { sourceInFrame: 30 })]);
    uploads.start(UPLOAD_ID, FILE);
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(kindOf(doc, cid(2))).toBe('video'));
    expect(vi.mocked(timelineApi.resolveAsset).mock.calls[0]?.slice(0, 2)).toEqual([PROJECT, ASSET_ID]);
    const read = readTimelineDocument(doc);
    const first = read.clips[cid(1)];
    const second = read.clips[cid(2)];
    expect(first).toMatchObject({ kind: 'video', trackId: V2, startFrame: 0, durationFrames: 30 });
    expect(second).toMatchObject({ kind: 'video', trackId: V2, startFrame: 30, sourceInFrame: 30, durationFrames: 30 });
    if (first?.kind === 'video' && second?.kind === 'video') expect(first.sourceId).toBe(second.sourceId);
    expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'done', asset: { assetId: ASSET_ID } });
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('tells its owner once the upload registered as a video, so Project video lists read again', async () => {
    const registered = vi.fn();
    const { doc, uploads } = open([uploadClip(cid(1), V2, 0)], registered);
    uploads.start(UPLOAD_ID, FILE);
    expect(registered).not.toHaveBeenCalled();
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(kindOf(doc, cid(1))).toBe('video'));
    expect(registered).toHaveBeenCalledTimes(1);
  });

  it('keeps running when the Space body is not mounted: the controller lives with the document', () => {
    const { doc, uploads } = open([uploadClip(cid(1), V2, 0)]);
    expect(getTimelineUploads(doc, NAME, { projectId: PROJECT, spaceId: SPACE })).toBe(uploads);
  });
});

describe('registration for the tab spinner and the close guard', () => {
  it('registers while the upload runs and its placeholder is in the document, and releases it on success', async () => {
    const { doc, uploads } = open([uploadClip(cid(1), V2, 0)]);
    expect(busy()).toBe(false);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(busy()).toBe(true));
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(kindOf(doc, cid(1))).toBe('video'));
    await vi.waitFor(() => expect(busy()).toBe(false));
  });

  it('releases on undo of the placeholder while the upload continues, and registers again on redo', async () => {
    const { doc, session, uploads } = open([]);
    expect(session.edit(addUpload(uploadClip(cid(1), V2, 0), OFF)).ok).toBe(true);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(busy()).toBe(true));
    session.undo();
    await vi.waitFor(() => expect(busy()).toBe(false));
    expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'uploading' });
    session.redo();
    await vi.waitFor(() => expect(busy()).toBe(true));
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(kindOf(doc, cid(1))).toBe('video'));
    expect(busy()).toBe(false);
  });

  it('releases when the placeholder is deleted, and still finishes the upload', async () => {
    const { session, uploads } = open([uploadClip(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(busy()).toBe(true));
    expect(session.edit({ operation: 'delete', parameters: { clipId: cid(1) }, placement: OFF }).ok).toBe(true);
    await vi.waitFor(() => expect(busy()).toBe(false));
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'done' }));
  });

  it('releases on failure and registers again on retry', async () => {
    const { uploads } = open([uploadClip(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(busy()).toBe(true));
    pending[0]?.reject(new UploadFailedError('transfer'));
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'failed' }));
    await vi.waitFor(() => expect(busy()).toBe(false));
    uploads.retry(UPLOAD_ID);
    await vi.waitFor(() => expect(busy()).toBe(true));
  });

  it('releases everything when the document is closed', async () => {
    const { uploads } = open([uploadClip(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(busy()).toBe(true));
    evictTimelineUploads(NAME);
    expect(busy()).toBe(false);
  });
});

describe('undo and redo across the conversion', () => {
  it('converts a placeholder that comes back on redo after the upload finished while it was undone', async () => {
    const { doc, session, uploads } = open([]);
    expect(session.edit(addUpload(uploadClip(cid(1), V2, 0), OFF)).ok).toBe(true);
    uploads.start(UPLOAD_ID, FILE);
    session.undo();
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'done' }));
    expect(doc.getMap('clips').has(cid(1))).toBe(false);
    session.redo();
    await vi.waitFor(() => expect(kindOf(doc, cid(1))).toBe('video'));
    expect(busy()).toBe(false);
  });

  it('keeps the clip a video when steps from before the conversion are undone and redone', async () => {
    const { doc, session, uploads } = open([]);
    expect(session.edit(addUpload(uploadClip(cid(1), V2, 0), OFF)).ok).toBe(true);
    expect(session.edit({ operation: 'move', parameters: { clipId: cid(1), startFrame: 40 }, placement: OFF }).ok).toBe(true);
    uploads.start(UPLOAD_ID, FILE);
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(kindOf(doc, cid(1))).toBe('video'));
    session.undo();
    await settle();
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', startFrame: 0 });
    session.undo();
    expect(doc.getMap('clips').has(cid(1))).toBe(false);
    session.redo();
    session.redo();
    await settle();
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', startFrame: 40 });
    for (const record of Object.values(clipRecords(doc))) expect(TimelineClipSchema.safeParse(record).success, JSON.stringify(record)).toBe(true);
  });
});

describe('write access', () => {
  it('waits without write access and converts when access returns', async () => {
    const { doc, provider, uploads } = open([uploadClip(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    provider.authorizedScope = 'readonly';
    provider.emit('authenticated');
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'done' }));
    await settle();
    expect(kindOf(doc, cid(1))).toBe('upload');
    expect(busy()).toBe(false);
    expect(claims(provider)).toEqual({ [UPLOAD_ID]: 'uploading' });
    provider.authorizedScope = 'read-write';
    provider.emit('authenticated');
    await vi.waitFor(() => expect(kindOf(doc, cid(1))).toBe('video'));
    await vi.waitFor(() => expect(claims(provider)).toEqual({}));
  });

  it('waits while the server refuses the document and converts once it accepts it again', async () => {
    const { doc, provider, uploads } = open([uploadClip(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    provider.emit('authenticationFailed', { reason: 'forbidden' });
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'done' }));
    await settle();
    expect(kindOf(doc, cid(1))).toBe('upload');
    provider.emit('authenticated');
    await vi.waitFor(() => expect(kindOf(doc, cid(1))).toBe('video'));
  });
});

describe('failures and retry', () => {
  it('fails without retry when sending the same file again cannot help', async () => {
    const { doc, provider, uploads } = open([uploadClip(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    pending[0]?.reject(new UploadFailedError('tooLarge'));
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toEqual({ phase: 'failed', reason: 'tooLarge', retryable: false }));
    await vi.waitFor(() => expect(claims(provider)).toEqual({ [UPLOAD_ID]: 'failed' }));
    expect(kindOf(doc, cid(1))).toBe('upload');
    uploads.retry(UPLOAD_ID);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure with the same file and converts on success', async () => {
    const { doc, provider, uploads } = open([uploadClip(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    pending[0]?.reject(new UploadFailedError('transfer'));
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'failed', retryable: true }));
    uploads.retry(UPLOAD_ID);
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect(pending[1]?.file).toBe(FILE);
    await vi.waitFor(() => expect(claims(provider)).toEqual({ [UPLOAD_ID]: 'uploading' }));
    pending[1]?.resolve(STORED);
    await vi.waitFor(() => expect(kindOf(doc, cid(1))).toBe('video'));
  });

  it('fails retryably when the registered asset cannot be read, and leaves the placeholder', async () => {
    vi.mocked(timelineApi.resolveAsset).mockReset().mockRejectedValue(new Error('network'));
    const { doc, uploads } = open([uploadClip(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'failed', retryable: true }));
    expect(kindOf(doc, cid(1))).toBe('upload');
  });

  it('retries a failed registration read without sending the file again', async () => {
    vi.mocked(timelineApi.resolveAsset).mockReset().mockRejectedValueOnce(new Error('network')).mockResolvedValue(registeredVideo(5));
    const { doc, uploads } = open([uploadClip(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'failed', retryable: true }));
    uploads.retry(UPLOAD_ID);
    await vi.waitFor(() => expect(kindOf(doc, cid(1))).toBe('video'));
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(vi.mocked(timelineApi.resolveAsset).mock.calls.map(([, assetId]) => assetId)).toEqual([ASSET_ID, ASSET_ID]);
  });

  it('fails without retry when the upload registered as something other than a video', async () => {
    const image: ProjectRegisteredAsset = registeredVideo(null, { kind: 'image', mimeType: 'image/png' });
    vi.mocked(timelineApi.resolveAsset).mockReset().mockResolvedValue(image);
    const registered = vi.fn();
    const { doc, uploads } = open([uploadClip(cid(1), V2, 0)], registered);
    uploads.start(UPLOAD_ID, FILE);
    pending[0]?.resolve({ ...STORED, kind: 'image' });
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toEqual({ phase: 'failed', reason: 'unsupportedType', retryable: false }));
    expect(kindOf(doc, cid(1))).toBe('upload');
    expect(registered).not.toHaveBeenCalled();
  });
});

describe('claims for collaborators', () => {
  it('publishes uploading, then nothing once the placeholder is converted', async () => {
    const { doc, provider, uploads } = open([uploadClip(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(claims(provider)).toEqual({ [UPLOAD_ID]: 'uploading' }));
    pending[0]?.resolve(STORED);
    await vi.waitFor(() => expect(kindOf(doc, cid(1))).toBe('video'));
    await vi.waitFor(() => expect(claims(provider)).toEqual({}));
  });
});

describe('a peer deletes the placeholder while it converts, then undoes the delete', () => {
  it.each([true, false])('ends with a valid video on both replicas (I receive first %s)', async (mineFirst) => {
    const { doc: mine, uploads } = open([clip(cid(9), MAIN, 0, 48), uploadClip(cid(1), V2, 0)]);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(mine));
    const peerName = docName.timelineSpace(PROJECT, '70000000-0000-4000-8000-000000000002');
    const peerSession = getTimelineEditSession(peer, peerName);
    const sync = (): void => {
      if (mineFirst) Y.applyUpdate(mine, Y.encodeStateAsUpdate(peer), 'remote');
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(mine), 'remote');
      if (!mineFirst) Y.applyUpdate(mine, Y.encodeStateAsUpdate(peer), 'remote');
    };
    try {
      uploads.start(UPLOAD_ID, FILE);
      pending[0]?.resolve(STORED);
      await vi.waitFor(() => expect(kindOf(mine, cid(1))).toBe('video'));
      expect(peerSession.edit({ operation: 'delete', parameters: { clipId: cid(1) }, placement: OFF }).ok).toBe(true);
      sync();
      peerSession.undo();
      sync();
      await vi.waitFor(() => expect(kindOf(mine, cid(1))).toBe('video'));
      sync();
      for (const doc of [mine, peer]) {
        for (const record of Object.values(clipRecords(doc))) expect(TimelineClipSchema.safeParse(record).success, JSON.stringify(record)).toBe(true);
        expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', trackId: V2, startFrame: 0 });
      }
    } finally {
      evictTimelineEditSession(peerName);
      peer.destroy();
    }
  });
});
