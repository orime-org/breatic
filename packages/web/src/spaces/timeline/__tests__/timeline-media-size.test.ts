// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec RQ-07
 * to RQ-09: the Timeline Add media dialog asks the server (upload, asset
 * resolution) before it writes, so it checks `canAdd` first; on a full Space
 * it sends nothing and shows the add sentence inside the dialog. A Space that
 * becomes full while the upload runs refuses the `add_video` write, and the
 * dialog shows the same sentence. The Yjs document is unchanged either way.
 *
 * Driven through the real material draft with the real edit session as its
 * `edit`, as `TimelineSpace` wires them; the dialog's sentence is read the
 * way `TimelineMaterialDialog` reads it (`timeline.errors.<errorKey>`).
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
import { evictTimelineEditSession, getTimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import { getTimelineMediaDraft, type TimelineMediaDraft } from '@web/spaces/timeline/timeline-media-draft';
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
 * @returns The document and the draft.
 */
function openDraft(): { doc: Y.Doc; draft: TimelineMediaDraft } {
  const doc = getDoc(NAME);
  const source = seededDoc(timeline([], [{ id: MAIN, kind: 'visual', order: 0 }], []));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source), 'remote');
  source.destroy();
  const session = getTimelineEditSession(doc, NAME);
  session.setCanWrite(true);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  const draft = getTimelineMediaDraft(doc, NAME, { projectId: PROJECT, spaceId: SPACE, queryClient, edit: (command) => session.edit(command) });
  draft.setCanWrite(true);
  draft.open(0, MAIN);
  return { doc, draft };
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
  evictTimelineEditSession(NAME);
  clearAllDocSizes();
  _resetForTests();
  vi.clearAllMocks();
});

describe('RQ-07 and RQ-08 confirming Add media on a full Space', () => {
  it('RQ-07 local video at F uploads nothing and the dialog shows the add sentence', async () => {
    const { doc, draft } = openDraft();
    draft.setMode('local');
    draft.setFile(clipFile);
    enterSize(NAME, 'F');
    toast.warning.mockClear();
    const before = Y.encodeStateAsUpdate(doc);

    await draft.confirm(ON);

    expect(uploadMedia).not.toHaveBeenCalled();
    expect(dialogError(draft)).toBe(SIZE_COPY_EN.T_ADD);
    expect(draft.getSnapshot().busy).toBe(false);
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
  it('RQ-09 the add_video write is refused and the dialog shows the add sentence', async () => {
    const { doc, draft } = openDraft();
    draft.setMode('local');
    draft.setFile(clipFile);
    enterSize(NAME, 'N');
    const upload = Promise.withResolvers<{ assetId: string; fileUrl: string; kind: string; width: number | null; height: number | null }>();
    uploadMedia.mockReturnValueOnce(upload.promise);
    const before = Y.encodeStateAsUpdate(doc);

    const confirmed = draft.confirm(ON);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    pushSize(NAME, P_FULL);
    upload.resolve({ assetId: ASSET.assetId, fileUrl: ASSET.fileUrl, kind: 'video', width: 1280, height: 720 });
    await confirmed;

    expect(dialogError(draft)).toBe(SIZE_COPY_EN.T_ADD);
    expect(draft.getSnapshot().busy).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});
