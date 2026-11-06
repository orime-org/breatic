// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec W-83 to W-86 and W-144: adding a video to
 * a Timeline reserves room before the upload (local file) or before the write
 * (Project video), shows a refusal inside the material dialog, carries the
 * reservation into `add_video` and releases it on failure or cancel.
 */

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import type * as ProviderModule from '@hocuspocus/provider';
import type { ProjectRegisteredAsset } from '@breatic/shared';
import { initializeTimelineDocument, readTimelineDocument } from '@breatic/shared/space-content';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/api/timeline')>();
  return { ...actual, timelineApi: { ...actual.timelineApi, listVideos: vi.fn(), resolveAsset: vi.fn(), limits: vi.fn() } };
});
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/upload/media-upload')>()),
  uploadMedia: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { timelineApi } from '@web/data/api/timeline';
import { uploadMedia, type StoredUpload } from '@web/data/upload/media-upload';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { TimelineMaterialDialog } from '@web/spaces/timeline/TimelineMaterialDialog';
import { getTimelineMediaDraft, type TimelineMediaDraft } from '@web/spaces/timeline/timeline-media-draft';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { sizeGateProviders, type SizeGateProvider } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { confirmLatest, expectRoom, handshake, openSizedDoc, probe, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import {
  COPY_EN,
  F_AFTER_WRITE,
  F_FULL,
  F_WARNING,
  F_WARNING_TIGHT,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const NAME = docName.timelineSpace(PROJECT, SPACE);
const SETTINGS = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const ASSET: ProjectRegisteredAsset = {
  assetId: '20000000-0000-4000-8000-000000000001',
  projectReferenceId: '50000000-0000-4000-8000-000000000001',
  displayName: 'Product launch.mp4', kind: 'video',
  fileUrl: 'https://cdn.example/registered-launch.mp4',
  coverUrl: 'https://cdn.example/registered-launch.jpg',
  width: 1280, height: 720, durationSeconds: 2, mimeType: 'video/mp4', sizeBytes: 8192,
};
const STORED: StoredUpload = { fileUrl: ASSET.fileUrl, assetId: ASSET.assetId, kind: 'video', width: ASSET.width, height: ASSET.height };
const clients: QueryClient[] = [];

/**
 * Hold a network outcome until the test settles it.
 * @returns The pending promise and its settlement functions.
 * @throws {never} Never.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

/**
 * Opens the registered Timeline document, seeds its persisted content as a
 * remote update, delivers one size push and opens the material form.
 * @param push - The size push.
 * @param mode - The material entry used.
 * @returns The document, its provider, the draft and its query cache.
 * @throws {Error} When seeding fails.
 */
async function draftAt(push: DocSizePush, mode: 'project' | 'local'): Promise<{ doc: Y.Doc; provider: SizeGateProvider; draft: TimelineMediaDraft; client: QueryClient }> {
  const { doc, provider } = openSizedDoc(NAME);
  const server = new Y.Doc();
  initializeTimelineDocument(server, SETTINGS);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server), 'provider');
  server.destroy();
  await handshake(NAME, provider);
  pushSize(provider, push);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const draft = getTimelineMediaDraft(doc, NAME, { projectId: PROJECT, spaceId: SPACE, queryClient: client });
  draft.setCanWrite(true);
  draft.open(0);
  draft.setMode(mode);
  if (mode === 'local') draft.setFile(new File(['video-bytes'], 'video.mp4', { type: 'video/mp4' }));
  else draft.select(ASSET);
  vi.mocked(toast.warning).mockClear();
  return { doc, provider, draft, client };
}

/**
 * Renders the material dialog over the draft.
 * @param draft - The draft shown.
 * @param client - Its query cache.
 * @returns Nothing.
 * @throws {Error} When rendering fails.
 */
function showDialog(draft: TimelineMediaDraft, client: QueryClient): void {
  render(React.createElement(QueryClientProvider, { client }, React.createElement(TooltipProvider, null,
    React.createElement(TimelineMaterialDialog, { projectId: PROJECT, spaceId: SPACE, draft, canWrite: true, onClose: () => {} }))));
}

/**
 * The clips the Timeline document holds.
 * @param doc - Timeline document.
 * @returns Clip ids.
 * @throws {Error} When the document is incompatible.
 */
function clipIds(doc: Y.Doc): string[] {
  return Object.keys(readTimelineDocument(doc).clips);
}

beforeEach(() => {
  sizeGateProviders.length = 0;
  useSpaceOperationsStore.setState({ operations: {} });
  vi.mocked(timelineApi.listVideos).mockReset().mockResolvedValue({ items: [ASSET], nextCursor: null });
  vi.mocked(timelineApi.resolveAsset).mockReset().mockResolvedValue(ASSET);
  vi.mocked(uploadMedia).mockReset().mockResolvedValue(STORED);
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  _resetCollabSocketForTests();
  _resetForTests();
  vi.clearAllMocks();
});

describe('W-83 a local video is refused before the upload when the Space is full', () => {
  it('uploads nothing and shows the timeline full copy in the dialog', async () => {
    const { doc, draft, client } = await draftAt(F_FULL, 'local');
    await draft.confirm();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(draft.getSnapshot().refusal).toEqual({ ok: false, reason: 'full' });
    expect(draft.getSnapshot().busy).toBe(false);
    expect(clipIds(doc)).toEqual([]);
    showDialog(draft, client);
    expect(screen.getByTestId('timeline-material-error')).toHaveTextContent(COPY_EN.T_TIMELINE_FULL);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-84 a local video whose estimate exceeds the room is refused as no_room', () => {
  it('uploads nothing and shows the room left in the dialog', async () => {
    const { doc, draft, client } = await draftAt(F_WARNING_TIGHT, 'local');
    await draft.confirm();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(draft.getSnapshot().refusal).toEqual({ ok: false, reason: 'no_room', room: 1 });
    expect(clipIds(doc)).toEqual([]);
    showDialog(draft, client);
    expect(screen.getByTestId('timeline-material-error')).toHaveTextContent(COPY_EN.T_NO_ROOM('1 B'));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-85 an accepted local video carries its reservation into add_video', () => {
  it('writes the clip, closes the form and releases the reservation after confirm and push', async () => {
    const { doc, provider, draft } = await draftAt(F_WARNING, 'local');
    await draft.confirm();
    expect(clipIds(doc)).toHaveLength(1);
    expect(draft.getSnapshot().open).toBe(false);
    // Still held: the write is not confirmed yet.
    expect(probe(NAME, 786432)).toBe(false);
    await confirmLatest(provider);
    pushSize(provider, F_AFTER_WRITE);
    expectRoom(NAME, 286432);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-86 a failed or cancelled local upload releases its reservation', () => {
  it('reports the upload failure and restores the room', async () => {
    const { draft } = await draftAt(F_WARNING, 'local');
    const upload = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(upload.promise);
    const running = draft.confirm();
    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    expect(probe(NAME, 786432)).toBe(false);
    upload.reject(new Error('network'));
    await running;
    expect(draft.getSnapshot().errorKey).toBe('upload');
    expectRoom(NAME, 786432);
  });

  it('restores the room when the dialog closes during the upload', async () => {
    const { doc, draft } = await draftAt(F_WARNING, 'local');
    const upload = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(upload.promise);
    const running = draft.confirm();
    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    expect(probe(NAME, 786432)).toBe(false);
    draft.close();
    upload.resolve(STORED);
    await running;
    expect(clipIds(doc)).toEqual([]);
    expectRoom(NAME, 786432);
  });
});

describe('W-144 a Project video reserves room the same way', () => {
  it('(a) is refused at full without resolving the asset', async () => {
    const { doc, draft, client } = await draftAt(F_FULL, 'project');
    const before = Y.encodeStateAsUpdate(doc);
    await draft.confirm();
    expect(draft.getSnapshot().refusal).toEqual({ ok: false, reason: 'full' });
    expect(timelineApi.resolveAsset).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    showDialog(draft, client);
    await screen.findByTestId('timeline-project-video-' + ASSET.assetId);
    expect(screen.getByTestId('timeline-material-error')).toHaveTextContent(COPY_EN.T_TIMELINE_FULL);
  });

  it('(b) is refused as no_room with the room left', async () => {
    const { doc, draft, client } = await draftAt(F_WARNING_TIGHT, 'project');
    await draft.confirm();
    expect(draft.getSnapshot().refusal).toEqual({ ok: false, reason: 'no_room', room: 1 });
    expect(clipIds(doc)).toEqual([]);
    showDialog(draft, client);
    await screen.findByTestId('timeline-project-video-' + ASSET.assetId);
    expect(screen.getByTestId('timeline-material-error')).toHaveTextContent(COPY_EN.T_NO_ROOM('1 B'));
  });

  it('(c) writes the clip and releases the reservation after confirm and push', async () => {
    const { doc, provider, draft } = await draftAt(F_WARNING, 'project');
    await draft.confirm();
    expect(clipIds(doc)).toHaveLength(1);
    expect(probe(NAME, 786432)).toBe(false);
    await confirmLatest(provider);
    pushSize(provider, F_AFTER_WRITE);
    expectRoom(NAME, 286432);
  });

  it('(d) releases the reservation when the asset cannot be resolved', async () => {
    const { doc, draft } = await draftAt(F_WARNING, 'project');
    vi.mocked(timelineApi.resolveAsset).mockReset().mockRejectedValue(new Error('gone'));
    await draft.confirm();
    expect(draft.getSnapshot().errorKey).toBe('source_unavailable');
    expect(clipIds(doc)).toEqual([]);
    expectRoom(NAME, 786432);
  });
});
