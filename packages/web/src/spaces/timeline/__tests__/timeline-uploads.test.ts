// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Timeline upload controller (#1434 design §3.1; inner#1709 design §4.1, §4.4, §7.2).
 *
 * `getTimelineUploads(doc, name, { projectId, spaceId })` in `timeline-uploads.ts` is a document-scoped controller,
 * kept beside the edit session and the media draft, so hiding the Space tab does not stop it. `start(uploadId, file)`
 * hands the file to the server with `handOffSpaceMedia`, naming the placeholder's `uploadId` and the Timeline as the
 * target, and ends there: collab writes the outcome into the placeholder, and this page never writes the document on
 * success. `entry(uploadId)` says where the upload stands on this page: `{ phase: 'uploading', progress }`,
 * `{ phase: 'handedOff' }` (the file kept for a retry after a server failure) or `{ phase: 'failed', reason, retryable }`
 * (the bytes never reached the server). While an upload is being sent and a placeholder of it is in the document, it is
 * registered with `useSpaceOperationsStore`; the page's awareness carries `uploads: { [uploadId]: 'uploading' | 'failed' }`
 * for collaborators, and drops the entry once the bytes are handed off. A retry renames every placeholder of the old
 * `uploadId` to a new one in a transaction no history records, drops what collab wrote, and sends the same file again.
 *
 * The network and the provider are faked at their module boundaries; the store, the edit session, the document
 * cache and the provider registry are real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

import { UploadFailedError, handOffSpaceMedia } from '@web/data/upload/media-upload';
import type * as MediaUploadModule from '@web/data/upload/media-upload';
import { _resetCollabSocketForTests, acquireDocProvider } from '@web/data/yjs/collab-socket';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { evictTimelineEditSession, getTimelineEditSession, type TimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { evictTimelineUploads, getTimelineUploads, type TimelineUploads } from '@web/spaces/timeline/timeline-uploads';
import { MAIN, OFF, SOURCE, V2, V3, cid, seededDoc, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { UPLOAD_ID, addUpload, clipRecords, uploadClip } from '@web/data/yjs/__tests__/timeline-upload-fixtures';

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
  return { ...actual, uploadMedia: vi.fn(), handOffSpaceMedia: vi.fn() };
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

/** One running fake hand-off. */
interface Pending { file: File; context: Record<string, unknown>; progress: (share: number) => void; resolve: () => void; reject: (err: unknown) => void }
const pending: Pending[] = [];

/**
 * A placeholder of `UPLOAD_ID` that names what it becomes.
 * @param id - The clip id.
 * @param trackId - Its track.
 * @param startFrame - Its start.
 * @param written - What collab wrote onto it.
 * @returns The clip.
 * @throws {never} Never.
 */
function placeholder(id: string, trackId: string, startFrame: number, written: Record<string, unknown> = {}): ReturnType<typeof uploadClip> {
  return uploadClip(id, trackId, startFrame, 60, { upload: { uploadId: UPLOAD_ID, name: 'beach.mp4', kind: 'video', durationSeconds: 2.5, ...written } as ReturnType<typeof uploadClip>['upload'] });
}

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
 * @returns The document, its provider, the session and the controller.
 * @throws {Error} When the fixture is invalid.
 */
function open(clips: Parameters<typeof timeline>[0]): { doc: Y.Doc; provider: FakeProvider; session: TimelineEditSession; uploads: TimelineUploads } {
  const doc = getDoc(NAME);
  // The placeholders are written as stored records, not through a schema of the version under test.
  const seeded = seededDoc(timeline([], TRACKS, [SOURCE]));
  seeded.transact(() => {
    for (const item of clips) {
      const record = new Y.Map<unknown>();
      seeded.getMap('clips').set(item.id, record);
      for (const [key, value] of Object.entries(item)) record.set(key, value);
    }
  }, 'setup');
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seeded));
  const provider = acquireDocProvider(NAME, doc) as unknown as FakeProvider;
  const session = getTimelineEditSession(doc, NAME);
  session.setCanWrite(true);
  const uploads = getTimelineUploads(doc, NAME, { projectId: PROJECT, spaceId: SPACE });
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
 * The stored `upload` field of a placeholder.
 * @param doc - The document.
 * @param clipId - The clip.
 * @returns The field as stored.
 * @throws {never} Never.
 */
function uploadOf(doc: Y.Doc, clipId: string): Record<string, unknown> | undefined {
  return (clipRecords(doc)[clipId] as { upload?: Record<string, unknown> } | undefined)?.upload;
}

/**
 * Write a server outcome onto every placeholder of an upload, as collab does under its own origin.
 * @param doc - The document.
 * @param uploadId - The upload.
 * @param written - The fields collab writes.
 * @throws {Error} When Yjs refuses the write.
 */
function collabWrites(doc: Y.Doc, uploadId: string, written: Record<string, unknown>): void {
  doc.transact(() => {
    doc.getMap<Y.Map<unknown>>('clips').forEach((record) => {
      const upload = record.get('upload') as Record<string, unknown> | undefined;
      if (upload?.uploadId === uploadId) record.set('upload', { ...upload, ...written });
    });
  }, 'collab');
}

beforeEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
  useSpaceOperationsStore.setState({ operations: {} });
  pending.splice(0);
  vi.mocked(handOffSpaceMedia).mockReset().mockImplementation((file, context, onProgress) => new Promise<void>((resolve, reject) => {
    pending.push({ file, context: context as unknown as Record<string, unknown>, progress: onProgress ?? ((): void => undefined), resolve, reject });
  }));
});

afterEach(() => {
  evictTimelineUploads(NAME);
  evictTimelineEditSession(NAME);
  _resetCollabSocketForTests();
  _resetForTests();
});

describe('a background upload', () => {
  it('hands the file to the server for this Project, Space, placeholder and the Timeline, and reports its progress as a share', async () => {
    const { uploads } = open([placeholder(cid(1), V2, 0)]);
    const listener = vi.fn();
    uploads.subscribe(listener);
    uploads.start(UPLOAD_ID, FILE);
    expect(pending[0]?.file).toBe(FILE);
    expect(pending[0]?.context).toMatchObject({ projectId: PROJECT, spaceId: SPACE, uploadId: UPLOAD_ID });
    expect(Object.values(pending[0]?.context ?? {})).toContain('timeline');
    expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'uploading' });
    pending[0]?.progress(0.42);
    expect(uploads.entry(UPLOAD_ID)).toEqual({ phase: 'uploading', progress: 0.42 });
    expect(listener).toHaveBeenCalled();
  });

  it('records the hand-off and writes nothing into the document: collab lands the placeholder (design §4.3)', async () => {
    const { doc, session, uploads } = open([placeholder(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    const before = Y.encodeStateAsUpdate(doc);
    pending[0]?.resolve();
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toEqual({ phase: 'handedOff' }));
    await settle();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(uploadOf(doc, cid(1))).toMatchObject({ uploadId: UPLOAD_ID });
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('keeps running when the Space body is not mounted: the controller lives with the document', () => {
    const { doc, uploads } = open([placeholder(cid(1), V2, 0)]);
    expect(getTimelineUploads(doc, NAME, { projectId: PROJECT, spaceId: SPACE })).toBe(uploads);
  });
});

describe('registration for the tab spinner and the close guard (design §7.2)', () => {
  it('registers while the bytes are sent and its placeholder is in the document, and releases it on the hand-off', async () => {
    const { uploads } = open([placeholder(cid(1), V2, 0)]);
    expect(busy()).toBe(false);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(busy()).toBe(true));
    pending[0]?.resolve();
    await vi.waitFor(() => expect(busy()).toBe(false));
  });

  it('releases on undo of the placeholder while the upload continues, and registers again on redo', async () => {
    const { session, uploads } = open([]);
    expect(session.edit(addUpload(placeholder(cid(1), V2, 0), OFF)).ok).toBe(true);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(busy()).toBe(true));
    session.undo();
    await vi.waitFor(() => expect(busy()).toBe(false));
    expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'uploading' });
    session.redo();
    await vi.waitFor(() => expect(busy()).toBe(true));
  });

  it('releases when the placeholder is deleted, and still hands the bytes off', async () => {
    const { session, uploads } = open([placeholder(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(busy()).toBe(true));
    expect(session.edit({ operation: 'delete', parameters: { clipId: cid(1) }, placement: OFF }).ok).toBe(true);
    await vi.waitFor(() => expect(busy()).toBe(false));
    pending[0]?.resolve();
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toEqual({ phase: 'handedOff' }));
  });

  it('releases on failure and registers again on retry', async () => {
    const { uploads } = open([placeholder(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(busy()).toBe(true));
    pending[0]?.reject(new UploadFailedError('transfer'));
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'failed' }));
    await vi.waitFor(() => expect(busy()).toBe(false));
    uploads.retry(UPLOAD_ID);
    await vi.waitFor(() => expect(busy()).toBe(true));
  });

  it('releases everything when the document is closed', async () => {
    const { uploads } = open([placeholder(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(busy()).toBe(true));
    evictTimelineUploads(NAME);
    expect(busy()).toBe(false);
  });
});

describe('failures and retry (design §4.4)', () => {
  it('fails without retry when sending the same file again cannot help', async () => {
    const { doc, provider, uploads } = open([placeholder(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    pending[0]?.reject(new UploadFailedError('tooLarge'));
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toEqual({ phase: 'failed', reason: 'tooLarge', retryable: false }));
    await vi.waitFor(() => expect(claims(provider)).toEqual({ [UPLOAD_ID]: 'failed' }));
    expect(uploadOf(doc, cid(1))?.uploadId).toBe(UPLOAD_ID);
    uploads.retry(UPLOAD_ID);
    expect(handOffSpaceMedia).toHaveBeenCalledTimes(1);
  });

  it('retries a local failure under a new upload id on every placeholder, outside any history, with the same file', async () => {
    const { doc, provider, session, uploads } = open([placeholder(cid(1), V2, 0), placeholder(cid(2), V3, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    pending[0]?.reject(new UploadFailedError('transfer'));
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toMatchObject({ phase: 'failed', retryable: true }));
    uploads.retry(UPLOAD_ID);
    await vi.waitFor(() => expect(handOffSpaceMedia).toHaveBeenCalledTimes(2));
    const renamed = String(pending[1]?.context.uploadId);
    expect(renamed).not.toBe(UPLOAD_ID);
    expect(pending[1]?.file).toBe(FILE);
    expect(uploadOf(doc, cid(1))?.uploadId).toBe(renamed);
    expect(uploadOf(doc, cid(2))?.uploadId).toBe(renamed);
    expect(uploads.entry(renamed)).toMatchObject({ phase: 'uploading' });
    await vi.waitFor(() => expect(claims(provider)).toEqual({ [renamed]: 'uploading' }));
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('retries a retryable failure collab wrote after the hand-off, dropping what collab wrote', async () => {
    const { doc, session, uploads } = open([placeholder(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    pending[0]?.resolve();
    await vi.waitFor(() => expect(uploads.entry(UPLOAD_ID)).toEqual({ phase: 'handedOff' }));
    collabWrites(doc, UPLOAD_ID, { state: 'failed', failure: 'failed', retryable: true });
    uploads.retry(UPLOAD_ID);
    await vi.waitFor(() => expect(handOffSpaceMedia).toHaveBeenCalledTimes(2));
    const upload = uploadOf(doc, cid(1));
    expect(upload?.uploadId).toBe(pending[1]?.context.uploadId);
    expect(upload?.uploadId).not.toBe(UPLOAD_ID);
    expect(upload).not.toHaveProperty('state');
    expect(upload).not.toHaveProperty('failure');
    expect(upload).not.toHaveProperty('retryable');
    expect(pending[1]?.file).toBe(FILE);
    expect(session.getSnapshot().canUndo).toBe(false);
  });
});

describe('claims for collaborators (design §7.2)', () => {
  it('publishes uploading, then drops the claim once the bytes are handed off', async () => {
    const { provider, uploads } = open([placeholder(cid(1), V2, 0)]);
    uploads.start(UPLOAD_ID, FILE);
    await vi.waitFor(() => expect(claims(provider)).toEqual({ [UPLOAD_ID]: 'uploading' }));
    pending[0]?.resolve();
    await vi.waitFor(() => expect(claims(provider)).toEqual({}));
  });
});
