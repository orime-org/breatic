// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { type ProjectRegisteredAsset, type TimelineDocumentV1, type TimelineVideoClip, type TimelineVideoSource } from '@breatic/shared';
import { applyTimelineEdit, initializeTimelineDocument, readTimelineDocument } from '@breatic/shared/space-content';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { uploadMedia, type StoredUpload } from '@web/data/upload/media-upload';
import type * as MediaUploadModule from '@web/data/upload/media-upload';
import { _resetForTests, destroyDoc, docName, getDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import type { SocketState } from '@web/data/yjs/use-socket';
import { TimelineSpace } from '@web/spaces/timeline/TimelineSpace';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, listVideos: vi.fn(), resolveAsset: vi.fn(), limits: vi.fn() } };
});
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaUploadModule>()),
  uploadMedia: vi.fn(),
}));

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const SETTINGS = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const ASSET: ProjectRegisteredAsset = {
  assetId: '20000000-0000-4000-8000-000000000001',
  projectReferenceId: '50000000-0000-4000-8000-000000000001',
  displayName: 'Product launch.mp4', kind: 'video',
  fileUrl: 'https://cdn.example/registered-launch.mp4',
  coverUrl: 'https://cdn.example/registered-launch.jpg',
  width: 1280, height: 720, durationSeconds: 2, mimeType: 'video/mp4', sizeBytes: 8192,
};
const LOCAL_ASSET: ProjectRegisteredAsset = {
  ...ASSET, assetId: '20000000-0000-4000-8000-000000000002',
  projectReferenceId: '50000000-0000-4000-8000-000000000002',
  displayName: 'Local video.mp4', fileUrl: 'https://cdn.example/registered-local.mp4',
};
const SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000001', kind: 'video', assetId: ASSET.assetId,
  timebase: SETTINGS.fps, extentFrames: 48, durationSeconds: '2', durationOrigin: 'registered',
};
const CLIP: TimelineVideoClip = {
  id: '30000000-0000-4000-8000-000000000001', kind: 'video', trackId: 'visual-1', sourceId: SOURCE.id,
  startFrame: 0, sourceInFrame: 0, durationFrames: 48, rate: { num: 1, den: 1 }, gain: 1, mute: false,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};
const CONNECTED: SocketState = {
  provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null,
};
const clients: QueryClient[] = [];

/**
 * Hold a network outcome while the user changes the current UI target.
 * @returns The pending answer and its explicit settlement functions.
 * @throws {never} Never.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

/**
 * Retrieve the actual manager-owned document used by this Space.
 * @returns The tab's cached Yjs document.
 * @throws {never} Never.
 */
function currentDoc(): Y.Doc {
  return getDoc(docName.timelineSpace(PROJECT, SPACE));
}

/**
 * Apply the persisted server seed through a real Yjs update.
 * @returns The client document after receiving the seed.
 * @throws {Error} When the seed cannot be encoded or applied.
 */
function seedContent(): Y.Doc {
  const server = new Y.Doc();
  try {
    initializeTimelineDocument(server, SETTINGS);
    Y.applyUpdate(currentDoc(), Y.encodeStateAsUpdate(server), 'provider');
    return currentDoc();
  } finally { server.destroy(); }
}

/**
 * Supply the existing application contexts around the real Timeline body.
 * @param client - This render's query cache.
 * @param connection - The open tab's connection facts.
 * @param readOnly - Whether the current Project role is Viewer.
 * @returns The actual application component tree.
 * @throws {never} Never.
 */
function surface(client: QueryClient, connection: SocketState = CONNECTED, readOnly = false): React.JSX.Element {
  return <QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={connection}>
    <TimelineSpace projectId={PROJECT} spaceId={SPACE} readOnly={readOnly} myRole={readOnly ? 'viewer' : 'editor'} />
  </SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>;
}

/**
 * Render Timeline with deterministic query retries.
 * @param connection - The facts supplied by the open Space tab.
 * @param readOnly - The current Project role's permission.
 * @param activityMode - The Space body's initial visibility when testing tab switches.
 * @returns The rendered view and cache for subsequent rerenders.
 * @throws {Error} When the actual body cannot render.
 */
function showTimeline(connection: SocketState = CONNECTED, readOnly = false, activityMode?: 'visible' | 'hidden'): { view: RenderResult; client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  const content = surface(client, connection, readOnly);
  return { view: render(activityMode === undefined ? content : <React.Activity mode={activityMode}>{content}</React.Activity>), client };
}

/**
 * Merge two independently accepted placements at the same start frame.
 * @returns The second placement's identity in the manager-owned document.
 * @throws {Error} When an independent placement cannot be accepted.
 */
function seedConflictingClips(): string {
  const doc = seedContent();
  const peer = new Y.Doc();
  const secondId = '30000000-0000-4000-8000-000000000002';
  try {
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    expect(applyTimelineEdit(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP } })).toBe(true);
    expect(applyTimelineEdit(peer, { operation: 'add_video', parameters: { source: SOURCE, clip: { ...CLIP, id: secondId } } })).toBe(true);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'provider');
    return secondId;
  } finally { peer.destroy(); }
}

/**
 * Open the material form through the actual track control.
 * @returns Its visible dialog.
 * @throws {Error} When the material entry is unreachable.
 */
async function openMaterial(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId('timeline-add-media'));
  return screen.findByRole('dialog');
}

/**
 * Explicitly confirm one listed registered video's captured placement.
 * @throws {Error} When the actual form cannot select or accept the video.
 */
async function addProjectVideo(): Promise<void> {
  await openMaterial();
  fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
  fireEvent.click(screen.getByTestId('timeline-confirm-material'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null));
}

/**
 * Read current integer-frame data through its production schema boundary.
 * @returns The native document projection.
 * @throws {Error} When its persisted format is incompatible.
 */
function layout(): TimelineDocumentV1 { return readTimelineDocument(currentDoc()); }

/**
 * Read the canonical result shape returned by the existing uploader.
 * @returns The registered local video's upload outcome.
 * @throws {never} Never.
 */
function stored(): StoredUpload {
  return { fileUrl: LOCAL_ASSET.fileUrl, assetId: LOCAL_ASSET.assetId, kind: LOCAL_ASSET.kind, width: LOCAL_ASSET.width, height: LOCAL_ASSET.height };
}

/**
 * Capture actual video elements at the DOM boundary used for metadata decoding.
 * @returns The created elements, including the ordinary preview element.
 * @throws {Error} When the DOM cannot construct an element.
 */
function captureVideoElements(): HTMLVideoElement[] {
  const createElement = document.createElement.bind(document);
  const videos: HTMLVideoElement[] = [];
  vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
    const element = createElement(tagName, options);
    if (element instanceof HTMLVideoElement) videos.push(element);
    return element;
  });
  return videos;
}

/**
 * Choose a real browser File and accept the selected fixed placement.
 * @param startFrame - The user-entered integer start frame.
 * @returns The selected File whose identity the uploader must retain.
 * @throws {Error} When the actual local-file entry is unreachable.
 */
async function confirmLocal(startFrame = 0): Promise<File> {
  await openMaterial();
  fireEvent.click(screen.getByTestId('timeline-material-local'));
  const file = new File(['registered-video-fixture'], 'Local video.mp4', { type: 'video/mp4' });
  fireEvent.change(screen.getByTestId('timeline-file-input'), { target: { files: [file] } });
  fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: String(startFrame) } });
  fireEvent.click(screen.getByTestId('timeline-confirm-material'));
  await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
  return file;
}

beforeEach(() => {
  _resetForTests();
  useSpaceOperationsStore.setState({ operations: {} });
  vi.mocked(timelineApi.listVideos).mockReset().mockResolvedValue({ items: [ASSET], nextCursor: null });
  vi.mocked(timelineApi.resolveAsset).mockReset().mockImplementation(async (_projectId, assetId) => assetId === LOCAL_ASSET.assetId ? LOCAL_ASSET : ASSET);
  vi.mocked(timelineApi.limits).mockReset().mockResolvedValue({ defaults: SETTINGS, assets: { pageSize: 50, pageMax: 100 } });
  vi.mocked(uploadMedia).mockReset().mockResolvedValue(stored());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  _resetForTests();
  useSpaceOperationsStore.setState({ operations: {} });
  vi.restoreAllMocks();
});

describe('TimelineSpace content and permissions', () => {
  it('keeps the selected conflicting placement distinct after focus moves to its editor', async () => {
    const secondId = seedConflictingClips();
    showTimeline();
    const first = await screen.findByTestId('timeline-conflict-' + CLIP.id);
    const second = screen.getByTestId('timeline-conflict-' + secondId);
    for (const [selected, other] of [[first, second], [second, first]]) {
      fireEvent.click(selected);
      expect(selected).toHaveClass('border-active-border', 'bg-status-error-bg');
      expect(selected).not.toHaveClass('border-status-error-border');
      expect(other).toHaveClass('border-status-error-border', 'bg-status-error-bg');
      expect(other).not.toHaveClass('border-active-border');
      screen.getByTestId('timeline-edit-start').focus();
      expect(selected).toHaveClass('border-active-border');
    }
  });
  it('shows a short conflict status in selected properties and retains the full instruction above', async () => {
    seedConflictingClips();
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-conflict-' + CLIP.id));
    const properties = within(screen.getByTestId('timeline-edit-start').parentElement!);
    expect(properties.getByText('Conflict', { exact: true })).toBeVisible();
    expect(properties.queryByText('Clips overlap. Select a clip and change its start frame.')).toBe(null);
    expect(screen.getAllByText('Clips overlap. Select a clip and change its start frame.').length).toBeGreaterThan(0);
  });
  it('waits for the first content sync even when a local document object exists', () => {
    seedContent();
    showTimeline({ ...CONNECTED, synced: false, hasEverSynced: false, status: 'connecting', writeAccess: 'unknown' });
    expect(screen.getByTestId('timeline-space-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-add-media')).toBe(null);
  });
  it('opens its persisted content when the first-sync gate changes', async () => {
    const { view, client } = showTimeline({ ...CONNECTED, synced: false, hasEverSynced: false, status: 'connecting' });
    expect(screen.getByTestId('timeline-space-loading')).toBeInTheDocument();
    act(() => { seedContent(); });
    view.rerender(surface(client));
    expect(await screen.findByTestId('timeline-track-visual-1')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-space-loading')).toBe(null);
  });
  it('reports refusal before first sync and preserves the empty document', () => {
    const before = Y.encodeStateAsUpdate(currentDoc());
    showTimeline({ ...CONNECTED, synced: false, hasEverSynced: false, status: 'authFailed', writeAccess: 'denied', authFailedReason: 'Forbidden' });
    expect(screen.getByTestId('timeline-space-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-space-loading')).toBe(null);
    expect(Y.encodeStateAsUpdate(currentDoc())).toEqual(before);
    expect([...currentDoc().share.keys()]).toEqual([]);
  });
  it('reports an incompatible version while retaining its stored data', () => {
    currentDoc().getMap('timeline').set('schemaVersion', 2);
    const before = Y.encodeStateAsUpdate(currentDoc());
    showTimeline();
    expect(screen.getByTestId('timeline-space-error')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-add-media')).toBe(null);
    expect(Y.encodeStateAsUpdate(currentDoc())).toEqual(before);
    expect([...currentDoc().share.keys()]).toEqual(['timeline']);
  });
  it('shows empty guidance, the initial visual track and the central preview', async () => {
    seedContent();
    showTimeline();
    expect(await screen.findByTestId('timeline-space-empty')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-track-visual-1')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-add-media')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-preview')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/locally saved|recovery copy|confirm.*saved/i);
  });
  it('retains existing clips during a disconnected period after the first sync', async () => {
    const doc = seedContent();
    expect(applyTimelineEdit(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP } })).toBe(true);
    showTimeline({ ...CONNECTED, synced: false, status: 'disconnected' });
    expect(await screen.findByTestId('timeline-clip-' + CLIP.id)).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-space-loading')).toBe(null);
  });
  it('shows a Viewer the shared clip and refuses material creation', async () => {
    const doc = seedContent();
    expect(applyTimelineEdit(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP } })).toBe(true);
    const before = Y.encodeStateAsUpdate(doc);
    showTimeline({ ...CONNECTED, writeAccess: 'denied' }, true);
    expect(await screen.findByTestId('timeline-clip-' + CLIP.id)).toBeInTheDocument();
    const add = screen.queryByTestId('timeline-add-media');
    if (add !== null) fireEvent.click(add);
    expect(screen.queryByRole('dialog')).toBe(null);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
  it('renders an addition received from another user through Yjs', async () => {
    const doc = seedContent();
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      showTimeline();
      const vector = Y.encodeStateVector(doc);
      expect(applyTimelineEdit(peer, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP } })).toBe(true);
      act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, vector), 'remote-provider'));
      expect(await screen.findByTestId('timeline-clip-' + CLIP.id)).toBeInTheDocument();
      expect(layout().clips[CLIP.id]).toEqual(CLIP);
    } finally { peer.destroy(); }
  });
});

describe('TimelineSpace registered-video placement', () => {
  it('opens the material form with Project and local-upload entries', async () => {
    seedContent();
    showTimeline();
    const dialog = await openMaterial();
    expect(within(dialog).getByTestId('timeline-material-project')).toBeInTheDocument();
    expect(within(dialog).getByTestId('timeline-material-local')).toBeInTheDocument();
    expect(within(dialog).getByTestId('timeline-start-frame')).toHaveValue(0);
  });
  it('keeps selecting a listed video separate from confirming its addition', async () => {
    const doc = seedContent();
    const before = Y.encodeStateAsUpdate(doc);
    showTimeline();
    await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(Object.keys(layout().clips)).toEqual([]);
    expect(screen.getByTestId('timeline-confirm-material')).toBeInTheDocument();
  });
  it('adds a confirmed video as one integer-frame clip and canonical source', async () => {
    seedContent();
    showTimeline();
    await addProjectVideo();
    const data = layout();
    const clips = Object.values(data.clips);
    expect(clips).toHaveLength(1);
    const clip = clips[0];
    expect(clip).toEqual({ ...CLIP, id: clip?.id, sourceId: clip?.sourceId });
    expect(Object.values(data.sources)).toHaveLength(1);
    expect(data.sources[clip?.sourceId ?? '']).toEqual({ ...SOURCE, id: clip?.sourceId });
    expect(JSON.stringify(data)).not.toContain(ASSET.fileUrl);
    expect(JSON.stringify(data)).not.toContain(ASSET.coverUrl);
    expect(await screen.findByTestId('timeline-clip-' + clip?.id)).toBeInTheDocument();
  });
  it('uses the selected explicit integer start frame', async () => {
    seedContent();
    showTimeline();
    await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '72' } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(1));
    expect(Object.values(layout().clips)[0]?.startFrame).toBe(72);
  });
  it('appends a repeated addition after the existing clip using a new identity', async () => {
    seedContent();
    showTimeline();
    await addProjectVideo();
    const first = Object.values(layout().clips)[0];
    await openMaterial();
    expect(screen.getByTestId('timeline-start-frame')).toHaveValue(48);
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(2));
    const clips = Object.values(layout().clips).sort((left, right) => left.startFrame - right.startFrame);
    expect(clips.map((clip) => clip.startFrame)).toEqual([0, 48]);
    expect(new Set(clips.map((clip) => clip.id)).size).toBe(2);
    expect(layout().clips[first?.id ?? '']).toEqual(first);
  });
  it('retains the draft and existing clip when the requested interval overlaps', async () => {
    const doc = seedContent();
    expect(applyTimelineEdit(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP } })).toBe(true);
    const before = Y.encodeStateAsUpdate(doc);
    showTimeline();
    await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    expect(await screen.findByTestId('timeline-material-error')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-start-frame')).toHaveValue(12);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
  it('shows a Project-list error and retries that same Project on request', async () => {
    vi.mocked(timelineApi.listVideos).mockRejectedValueOnce(new Error('List temporarily unavailable'));
    seedContent();
    showTimeline();
    await openMaterial();
    expect(await screen.findByTestId('timeline-material-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('timeline-material-retry'));
    expect(await screen.findByTestId('timeline-project-video-' + ASSET.assetId)).toBeInTheDocument();
    expect(vi.mocked(timelineApi.listVideos).mock.calls.map(([projectId]) => projectId)).toEqual([PROJECT, PROJECT]);
  });
  it('keeps a delayed former list request isolated after its dialog closes', async () => {
    const answer = deferred<{ items: ProjectRegisteredAsset[]; nextCursor: null }>();
    vi.mocked(timelineApi.listVideos).mockReturnValueOnce(answer.promise);
    seedContent();
    showTimeline();
    const first = await openMaterial();
    fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null));
    await act(async () => answer.resolve({ items: [ASSET], nextCursor: null }));
    expect(screen.queryByRole('dialog')).toBe(null);
    expect(Object.keys(layout().clips)).toEqual([]);
    await openMaterial();
    expect(await screen.findByTestId('timeline-project-video-' + ASSET.assetId)).toBeInTheDocument();
  });
});

describe('TimelineSpace browser metadata boundary', () => {
  it('uses the registered duration while creating only the ordinary preview video', async () => {
    const videos = captureVideoElements();
    seedContent();
    showTimeline();
    await addProjectVideo();
    expect(Object.values(layout().clips)[0]?.durationFrames).toBe(48);
    expect(Object.values(layout().sources)[0]?.durationOrigin).toBe('registered');
    expect(videos.filter((video) => video.preload === 'metadata')).toEqual([]);
  });

  it('retains a metadata failure draft and accepts browser metadata on explicit retry', async () => {
    const asset = { ...ASSET, durationSeconds: null };
    vi.mocked(timelineApi.listVideos).mockResolvedValue({ items: [asset], nextCursor: null });
    vi.mocked(timelineApi.resolveAsset).mockResolvedValue(asset);
    const videos = captureVideoElements();
    const doc = seedContent();
    const before = Y.encodeStateAsUpdate(doc);
    showTimeline();
    await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + asset.assetId));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '72' } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(videos.filter((video) => video.preload === 'metadata')).toHaveLength(1));
    const first = videos.find((video) => video.preload === 'metadata');
    if (first === undefined) throw new Error('The current metadata decoder was not created');
    expect(first.getAttribute('src')).toBe(asset.fileUrl);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    fireEvent(first, new Event('error'));
    expect(await screen.findByTestId('timeline-material-error')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-start-frame')).toHaveValue(72);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(first.getAttribute('src')).toBe(null);
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(videos.filter((video) => video.preload === 'metadata')).toHaveLength(2));
    const second = videos.find((video) => video.preload === 'metadata' && video !== first);
    if (second === undefined) throw new Error('The retried metadata decoder was not created');
    expect(second.getAttribute('src')).toBe(asset.fileUrl);
    Object.defineProperty(second, 'duration', { configurable: true, value: 1.25 });
    fireEvent(second, new Event('loadedmetadata'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(1));
    const clip = Object.values(layout().clips)[0];
    expect(clip?.startFrame).toBe(72);
    expect(clip?.durationFrames).toBe(30);
    expect(Object.values(layout().sources)).toEqual([{
      ...SOURCE, id: clip?.sourceId, durationOrigin: 'decoded', durationSeconds: '1.25', extentFrames: 30,
    }]);
    expect(asset.durationSeconds).toBe(null);
    expect(second.getAttribute('src')).toBe(null);
    expect(screen.queryByRole('dialog')).toBe(null);
  });
});

describe('TimelineSpace local uploads and captured targets', () => {
  it('requires explicit confirmation after a Viewer role arrives while the Space is hidden', async () => {
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    const doc = seedContent();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
    clients.push(client);
    const observedRole = vi.fn();
    /**
     * Confirm that React rendered the updated role inside the hidden Activity.
     * @param props - The current Project role's editing restriction.
     * @returns The same real Timeline body under its existing contexts.
     * @throws {never} Never.
     */
    function RoleFrame({ readOnly }: { readOnly: boolean }): React.JSX.Element {
      observedRole(readOnly);
      return surface(client, readOnly ? { ...CONNECTED, writeAccess: 'denied' } : CONNECTED, readOnly);
    }
    const view = render(<React.Activity mode='visible'><RoleFrame readOnly={false} /></React.Activity>);
    const file = await confirmLocal(72);
    view.rerender(<React.Activity mode='hidden'><RoleFrame readOnly={false} /></React.Activity>);
    await act(async () => {
      view.rerender(<React.Activity mode='hidden'><RoleFrame readOnly /></React.Activity>);
    });
    await waitFor(() => expect(observedRole).toHaveBeenLastCalledWith(true));
    const before = Y.encodeStateAsUpdate(doc);
    await act(async () => answer.resolve(stored()));
    await waitFor(() => expect(useSpaceOperationsStore.getState().hasOperations(SPACE)).toBe(false));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(currentDoc()).toBe(doc);
    expect(doc.isDestroyed).toBe(false);
    view.rerender(<React.Activity mode='visible'><RoleFrame readOnly={false} /></React.Activity>);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-start-frame')).toHaveValue(72);
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(1));
    expect(Object.values(layout().clips)[0]?.startFrame).toBe(72);
    expect(Object.values(layout().sources)[0]?.assetId).toBe(LOCAL_ASSET.assetId);
    expect(vi.mocked(uploadMedia).mock.calls.map(([sentFile]) => sentFile)).toEqual([file]);
    expect(screen.queryByRole('dialog')).toBe(null);
  });

  it('releases its operation on document destruction and discards the late upload result', async () => {
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    const doc = seedContent();
    showTimeline();
    await confirmLocal(72);
    expect(useSpaceOperationsStore.getState().hasOperations(SPACE)).toBe(true);
    const before = Y.encodeStateAsUpdate(doc);
    try {
      act(() => destroyDoc(docName.timelineSpace(PROJECT, SPACE)));
      expect(doc.isDestroyed).toBe(true);
      expect(useSpaceOperationsStore.getState().hasOperations(SPACE)).toBe(false);
    } finally {
      await act(async () => answer.resolve(stored()));
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(useSpaceOperationsStore.getState().hasOperations(SPACE)).toBe(false);
  });

  it('requires a new confirmation after a Viewer interval and reuses its registered upload', async () => {
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    const doc = seedContent();
    const { view, client } = showTimeline();
    const file = await confirmLocal(72);
    view.rerender(surface(client, { ...CONNECTED, writeAccess: 'denied' }, true));
    view.rerender(surface(client, CONNECTED, false));
    const before = Y.encodeStateAsUpdate(doc);
    await act(async () => answer.resolve(stored()));
    await waitFor(() => expect(useSpaceOperationsStore.getState().hasOperations(SPACE)).toBe(false));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-start-frame')).toHaveValue(72);
    expect(screen.getByTestId('timeline-confirm-material')).toBeEnabled();
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(1));
    expect(Object.values(layout().clips)[0]?.startFrame).toBe(72);
    expect(Object.values(layout().sources)[0]?.assetId).toBe(LOCAL_ASSET.assetId);
    expect(vi.mocked(uploadMedia).mock.calls.map(([sentFile]) => sentFile)).toEqual([file]);
    expect(screen.queryByRole('dialog')).toBe(null);
  });

  it('preserves a pending upload and its captured frame across a Space hide and show', async () => {
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    const doc = seedContent();
    const { view, client } = showTimeline(CONNECTED, false, 'visible');
    const file = await confirmLocal(72);
    view.rerender(<React.Activity mode='hidden'>{surface(client)}</React.Activity>);
    expect(currentDoc()).toBe(doc);
    expect(doc.isDestroyed).toBe(false);
    view.rerender(<React.Activity mode='visible'>{surface(client)}</React.Activity>);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-start-frame')).toHaveValue(72);
    const confirm = screen.getByTestId('timeline-confirm-material');
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(confirm);
    expect(vi.mocked(uploadMedia).mock.calls.map(([sentFile]) => sentFile)).toEqual([file]);
    await act(async () => answer.resolve(stored()));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(1));
    expect(Object.values(layout().clips)[0]?.startFrame).toBe(72);
    expect(Object.values(layout().sources)[0]?.assetId).toBe(LOCAL_ASSET.assetId);
    expect(screen.queryByRole('dialog')).toBe(null);
    expect(vi.mocked(uploadMedia).mock.calls).toHaveLength(1);
  });

  it('accepts the fixed upload placement while its Space is hidden and shows it on return', async () => {
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    const doc = seedContent();
    const { view, client } = showTimeline(CONNECTED, false, 'visible');
    const file = await confirmLocal(72);
    view.rerender(<React.Activity mode='hidden'>{surface(client)}</React.Activity>);
    await act(async () => answer.resolve(stored()));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(1));
    const clip = Object.values(layout().clips)[0];
    expect(clip?.startFrame).toBe(72);
    expect(clip?.durationFrames).toBe(48);
    expect(Object.values(layout().sources)[0]?.assetId).toBe(LOCAL_ASSET.assetId);
    expect(currentDoc()).toBe(doc);
    expect(doc.isDestroyed).toBe(false);
    view.rerender(<React.Activity mode='visible'>{surface(client)}</React.Activity>);
    expect(await screen.findByTestId('timeline-clip-' + clip?.id)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBe(null);
    expect(screen.getByTestId('timeline-add-media')).toBeEnabled();
    expect(vi.mocked(uploadMedia).mock.calls.map(([sentFile]) => sentFile)).toEqual([file]);
  });

  it('uploads a confirmed local video through the shared Project uploader', async () => {
    seedContent();
    showTimeline();
    const file = await confirmLocal();
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(1));
    expect(vi.mocked(uploadMedia).mock.calls).toHaveLength(1);
    expect(vi.mocked(uploadMedia).mock.calls[0]?.[0]).toBe(file);
    expect(vi.mocked(uploadMedia).mock.calls[0]?.[1]).toMatchObject({ projectId: PROJECT });
    expect(vi.mocked(uploadMedia).mock.calls[0]?.[1].nodeId).toBe(undefined);
    expect(Object.values(layout().sources)[0]?.assetId).toBe(LOCAL_ASSET.assetId);
  });
  it('keeps the captured upload frame when collaborative content changes meanwhile', async () => {
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    const doc = seedContent();
    showTimeline();
    await confirmLocal(72);
    act(() => { expect(applyTimelineEdit(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP } })).toBe(true); });
    await act(async () => answer.resolve(stored()));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(2));
    const uploaded = Object.values(layout().clips).find((clip) => layout().sources[clip.sourceId]?.assetId === LOCAL_ASSET.assetId);
    expect(uploaded?.startFrame).toBe(72);
    expect(uploaded?.durationFrames).toBe(48);
  });
  it('retains the local file and selected frame after an upload failure', async () => {
    vi.mocked(uploadMedia).mockRejectedValueOnce(new Error('Upload temporarily unavailable'));
    seedContent();
    showTimeline();
    const file = await confirmLocal(72);
    expect(await screen.findByTestId('timeline-material-error')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-start-frame')).toHaveValue(72);
    expect(Object.keys(layout().clips)).toEqual([]);
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(1));
    expect(vi.mocked(uploadMedia).mock.calls.map(([sentFile]) => sentFile)).toEqual([file, file]);
    expect(Object.values(layout().clips)[0]?.startFrame).toBe(72);
  });
  it('keeps a canceled upload result from replacing a newly confirmed selection', async () => {
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    seedContent();
    showTimeline();
    await confirmLocal();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null));
    await addProjectVideo();
    const before = Y.encodeStateAsUpdate(currentDoc());
    await act(async () => answer.resolve(stored()));
    expect(Y.encodeStateAsUpdate(currentDoc())).toEqual(before);
    expect(Object.values(layout().sources).map((source) => source.assetId)).toEqual([ASSET.assetId]);
    expect(Object.values(layout().clips)).toHaveLength(1);
  });
  it('preserves the layout when an upload completes after the user becomes Viewer', async () => {
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    seedContent();
    const { view, client } = showTimeline();
    await confirmLocal();
    view.rerender(surface(client, { ...CONNECTED, writeAccess: 'denied' }, true));
    const before = Y.encodeStateAsUpdate(currentDoc());
    await act(async () => answer.resolve(stored()));
    expect(Y.encodeStateAsUpdate(currentDoc())).toEqual(before);
    expect(Object.keys(layout().clips)).toEqual([]);
  });
});

describe('TimelineSpace collaborative overlap correction', () => {
  it('keeps both overlapping clips and permits an explicit start-frame correction', async () => {
    const doc = seedContent();
    const first = new Y.Doc();
    const second = new Y.Doc();
    const otherClip = { ...CLIP, id: '30000000-0000-4000-8000-000000000002', sourceId: '10000000-0000-4000-8000-000000000002' };
    const otherSource = { ...SOURCE, id: otherClip.sourceId };
    try {
      const seed = Y.encodeStateAsUpdate(doc);
      Y.applyUpdate(first, seed);
      Y.applyUpdate(second, seed);
      expect(applyTimelineEdit(first, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP } })).toBe(true);
      expect(applyTimelineEdit(second, { operation: 'add_video', parameters: { source: otherSource, clip: otherClip } })).toBe(true);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(first), 'first-peer');
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(second), 'second-peer');
      showTimeline();
      expect(await screen.findByTestId('timeline-clip-' + CLIP.id)).toBeInTheDocument();
      expect(screen.getByTestId('timeline-clip-' + otherClip.id)).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('timeline-clip-' + otherClip.id));
      fireEvent.click(await screen.findByTestId('timeline-edit-start'));
      fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '48' } });
      fireEvent.click(screen.getByTestId('timeline-apply-start'));
      await waitFor(() => expect(layout().clips[otherClip.id]?.startFrame).toBe(48));
      expect(layout().clips[CLIP.id]).toEqual(CLIP);
      expect(Object.values(layout().clips)).toHaveLength(2);
      expect(layout().sources[otherSource.id]).toEqual(otherSource);
    } finally { first.destroy(); second.destroy(); }
  });
});
