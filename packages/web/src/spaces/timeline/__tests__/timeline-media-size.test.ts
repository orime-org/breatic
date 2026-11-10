// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec RQ-07
 * to RQ-09: the Timeline Add media dialog asks the server (upload, asset
 * resolution, or the background upload of a local video) before it writes,
 * so it checks `canAdd` first; on a full Space it sends nothing, places
 * nothing and shows the add sentence inside the dialog. A local video
 * confirmed with room is placed as an upload placeholder at once; when the
 * Space becomes full while it uploads, the placeholder is not converted and
 * shows the shared waiting sentence.
 *
 * Driven through the real material draft with the real edit session as its
 * `edit` and the real background uploads as its `startUpload`, as
 * `TimelineSpace` wires them; the dialog's sentence is read the way
 * `TimelineMaterialDialog` reads it (`timeline.errors.<errorKey>`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { QueryClient } from '@tanstack/react-query';
import { t, type ProjectRegisteredAsset } from '@breatic/shared';
import type * as MediaUploadModule from '@web/data/upload/media-upload';
import type * as TimelineApiModule from '@web/data/api/timeline';

const { toast, uploadMedia, resolveAsset } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  uploadMedia: vi.fn(),
  resolveAsset: vi.fn(),
}));
vi.mock('@web/lib/toast', () => ({ toast, muteToasts: vi.fn(), _unmuteToastsForTests: vi.fn() }));
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaUploadModule>()),
  uploadMedia,
}));
vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, resolveAsset } };
});

import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { readTimelineDocument } from '@web/data/yjs/timeline-document';
import { evictTimelineEditSession, getTimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import { getTimelineMediaDraft, type TimelineMediaDraft } from '@web/spaces/timeline/timeline-media-draft';
import { evictTimelineUploads, getTimelineUploads, type TimelineUploads } from '@web/spaces/timeline/timeline-uploads';
import { timelineUploadText, timelineUploadView } from '@web/spaces/timeline/use-timeline-upload-views';
import { MAIN, ON, seededDoc, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { P_FULL, SIZE_COPY_EN, enterSize, pushSize } from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PROJECT = 'p1';
const SPACE = 't1';
const NAME = docName.timelineSpace(PROJECT, SPACE);
const ASSET: ProjectRegisteredAsset = {
  assetId: '20000000-0000-4000-8000-000000000009',
  projectReferenceId: '50000000-0000-4000-8000-000000000009',
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
const clipFile = new File(['bytes'], 'demo.mp4', { type: 'video/mp4' });
const clients: QueryClient[] = [];

/**
 * An open Timeline (main track only, loaded as a peer's update) with its
 * material draft open at frame 0 on the main track.
 * @returns The document, the draft, its background uploads and the spy on
 * its `startUpload`.
 */
function openDraft(): { doc: Y.Doc; draft: TimelineMediaDraft; uploads: TimelineUploads; startUpload: ReturnType<typeof vi.fn> } {
  const doc = getDoc(NAME);
  const source = seededDoc(timeline([], [{ id: MAIN, kind: 'visual', order: 0 }], []));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source), 'remote');
  source.destroy();
  const session = getTimelineEditSession(doc, NAME);
  session.setCanWrite(true);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  const uploads = getTimelineUploads(doc, NAME, { projectId: PROJECT, spaceId: SPACE });
  const startUpload = vi.fn((uploadId: string, file: File) => { uploads.start(uploadId, file); });
  const draft = getTimelineMediaDraft(doc, NAME, { projectId: PROJECT, spaceId: SPACE, queryClient, edit: (command, options) => session.edit(command, options), startUpload });
  draft.setCanWrite(true);
  draft.open(0, MAIN);
  return { doc, draft, uploads, startUpload };
}

/**
 * The sentence the dialog shows for the draft's error.
 * @param draft - The draft.
 * @returns The sentence, or null when there is none.
 */
function dialogError(draft: TimelineMediaDraft): string | null {
  const { errorKey } = draft.getSnapshot();
  return errorKey === null ? null : t(`timeline.errors.${errorKey}`);
}

beforeEach(() => {
  uploadMedia.mockResolvedValue({ assetId: ASSET.assetId, fileUrl: ASSET.fileUrl, kind: 'video', width: 1280, height: 720 });
  resolveAsset.mockResolvedValue(ASSET);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  evictTimelineUploads(NAME);
  evictTimelineEditSession(NAME);
  clearAllDocSizes();
  _resetForTests();
  vi.clearAllMocks();
});

describe('RQ-07 and RQ-08 confirming Add media on a full Space', () => {
  it('RQ-07 local video at F uploads nothing, places nothing and the dialog shows the add sentence', async () => {
    const { doc, draft, startUpload } = openDraft();
    draft.setMode('local');
    draft.setFile(clipFile);
    enterSize(NAME, 'F');
    toast.warning.mockClear();
    const before = Y.encodeStateAsUpdate(doc);

    await draft.confirm(ON);

    expect(uploadMedia).not.toHaveBeenCalled();
    expect(startUpload).not.toHaveBeenCalled();
    expect(dialogError(draft)).toBe(SIZE_COPY_EN.T_ADD);
    expect(draft.getSnapshot()).toMatchObject({ busy: false, open: true });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('RQ-08 project video at F asks nothing and the dialog shows the add sentence', async () => {
    const { doc, draft } = openDraft();
    draft.setMode('project');
    draft.select(ASSET);
    enterSize(NAME, 'F');
    toast.warning.mockClear();
    const before = Y.encodeStateAsUpdate(doc);

    await draft.confirm(ON);

    expect(resolveAsset).not.toHaveBeenCalled();
    expect(dialogError(draft)).toBe(SIZE_COPY_EN.T_ADD);
    expect(draft.getSnapshot().busy).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('RQ-09 the Space becomes full while the local video uploads', () => {
  it('RQ-09 the placeholder is placed at once, is not converted once the upload finishes on a full Space, and shows the waiting sentence', async () => {
    const { doc, draft, uploads, startUpload } = openDraft();
    draft.setMode('local');
    draft.setFile(clipFile);
    enterSize(NAME, 'N');
    const upload = Promise.withResolvers<{ assetId: string; fileUrl: string; kind: string; width: number | null; height: number | null }>();
    uploadMedia.mockReturnValueOnce(upload.promise);
    // jsdom has no object URLs and its media elements load no metadata: the
    // local file reports a 2-second duration, as a browser would.
    const urlDescriptors = (['createObjectURL', 'revokeObjectURL'] as const).map((key) => [key, Object.getOwnPropertyDescriptor(URL, key)] as const);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (): string => 'blob:demo' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (): void => undefined });
    const duration = vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(2);
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement): void {
      if (this.getAttribute('src') !== null) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
    });
    try {
      await draft.confirm(ON);
    } finally {
      duration.mockRestore();
      load.mockRestore();
      for (const [key, descriptor] of urlDescriptors) {
        if (descriptor === undefined) Reflect.deleteProperty(URL, key);
        else Object.defineProperty(URL, key, descriptor);
      }
    }
    expect(startUpload).toHaveBeenCalledTimes(1);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(draft.getSnapshot().open).toBe(false);
    const placeholders = Object.values(readTimelineDocument(doc).clips).filter((clip) => clip.kind === 'upload');
    expect(placeholders).toHaveLength(1);
    const sources = Object.keys(readTimelineDocument(doc).sources).length;

    pushSize(NAME, P_FULL);
    upload.resolve({ assetId: ASSET.assetId, fileUrl: ASSET.fileUrl, kind: 'video', width: 1280, height: 720 });
    const uploadId = placeholders[0]?.kind === 'upload' ? placeholders[0].upload.uploadId : '';
    await vi.waitFor(() => expect(uploads.entry(uploadId)).toMatchObject({ phase: 'done' }));
    for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readTimelineDocument(doc).clips[placeholders[0]!.id]?.kind).toBe('upload');
    expect(Object.keys(readTimelineDocument(doc).sources)).toHaveLength(sources);
    expect(timelineUploadText(t, timelineUploadView(uploads.entry(uploadId), 'granted', null, true), 'demo.mp4')).toBe(SIZE_COPY_EN.T_WAIT);
    expect(draft.getSnapshot()).toMatchObject({ open: false, errorKey: null });
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
