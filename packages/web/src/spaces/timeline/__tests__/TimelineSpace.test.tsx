// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  t, type ProjectRegisteredAsset, type TimelineDocumentV1, type TimelineEditCommand, type TimelineTrack,
  type TimelineVideoClip, type TimelineVideoSource,
} from '@breatic/shared';
import { applyTimelineEdit, initializeTimelineDocument, readTimelineDocument } from '@breatic/shared/space-content';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { uploadMedia, type StoredUpload } from '@web/data/upload/media-upload';
import type * as MediaUploadModule from '@web/data/upload/media-upload';
import { _resetForTests, destroyDoc, docName, getDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import { toast } from '@web/lib/toast';
import { writeUserPreference } from '@web/lib/user-preferences-storage';
import { useCurrentUserStore, useUIStore } from '@web/stores';
import { MAIN, clip as clipAt, seededDoc, timeline, track } from '@web/spaces/timeline/__tests__/timeline-edit-fixtures';
import type { SocketState } from '@web/data/yjs/use-socket';
import { TimelineSpace } from '@web/spaces/timeline/TimelineSpace';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, listVideos: vi.fn(), resolveAsset: vi.fn(), limits: vi.fn() } };
});
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
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
const ME = 'user-timeline-editor';
const ON = { magnet: true, linkage: true } as const;
const OFF = { magnet: false, linkage: false } as const;
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
    <div data-region='space'><TimelineSpace projectId={PROJECT} spaceId={SPACE} readOnly={readOnly} myRole={readOnly ? 'viewer' : 'editor'} /></div>
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
 * Apply an edit as a setup or peer write that no personal history tracks.
 * @param doc - The document to edit.
 * @param command - The edit.
 * @throws {Error} When the edit is refused.
 */
function write(doc: Y.Doc, command: TimelineEditCommand): void {
  const plan = applyTimelineEdit(doc, command, 'test-setup');
  if (!plan.ok) throw new Error(`Setup edit refused: ${plan.reason}`);
}

/**
 * Apply a server seed holding these tracks and clips (all of `SOURCE`) through a real Yjs update.
 * @param clips - The clips.
 * @param tracks - The tracks; main and v2 by default.
 * @returns The manager-owned client document.
 * @throws {Error} When the fixture is invalid.
 */
function seedLayout(clips: TimelineVideoClip[], tracks: TimelineTrack[] = [track(MAIN, 0), track('v2', 1)]): Y.Doc {
  const server = seededDoc(timeline(clips, tracks, [SOURCE]));
  try {
    Y.applyUpdate(currentDoc(), Y.encodeStateAsUpdate(server), 'provider');
    return currentDoc();
  } finally { server.destroy(); }
}

/**
 * Merge two independently accepted placements at the same start frame of sub track v2.
 * @returns The second placement's identity in the manager-owned document.
 * @throws {Error} When an independent placement cannot be accepted.
 */
function seedConflictingClips(): string {
  const doc = seedLayout([]);
  const peer = new Y.Doc();
  const secondId = '30000000-0000-4000-8000-000000000002';
  try {
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    write(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: { ...CLIP, trackId: 'v2' } }, placement: OFF });
    write(peer, { operation: 'add_video', parameters: { source: SOURCE, clip: { ...CLIP, id: secondId, trackId: 'v2' } }, placement: OFF });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'provider');
    return secondId;
  } finally { peer.destroy(); }
}

/**
 * Store the signed-in editor's magnet switch before the Space renders.
 * @param on - Whether main-track magnet is on.
 * @throws {never} Never.
 */
function magnet(on: boolean): void {
  writeUserPreference(ME, { timelineMagnet: on });
}

/**
 * The smallest element holding the selected clip's start and duration fields: the properties area.
 * @returns The properties container.
 * @throws {Error} When no clip is selected.
 */
function properties(): HTMLElement {
  const start = screen.getByTestId('timeline-clip-start');
  let node: HTMLElement | null = start.parentElement;
  while (node !== null && node.querySelector('[data-testid="timeline-clip-duration"]') === null) node = node.parentElement;
  if (node === null) throw new Error('No properties area');
  return node;
}

/**
 * Press a key on an element inside the Timeline Space.
 * @param target - The focused element.
 * @param key - The key value.
 * @param modifiers - Modifier and repeat flags.
 * @throws {Error} When a handler throws.
 */
function press(target: Element, key: string, modifiers: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'repeat'>> = {}): void {
  if (target instanceof HTMLElement) target.focus();
  fireEvent.keyDown(target, { key, ...modifiers });
}

/**
 * Commit a properties field through Enter.
 * @param testId - The field's test id.
 * @param value - The typed text.
 * @throws {Error} When the field is absent.
 */
function commitField(testId: string, value: string): void {
  const field = screen.getByTestId(testId);
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: 'Enter' });
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
  window.localStorage.clear();
  useCurrentUserStore.setState({ user: { id: ME, name: 'Me', email: 'me@e.com', personalStudio: { name: 'Me', slug: 'me', avatarUrl: null }, membershipTier: 'base' } });
  useUIStore.setState({ activeRegion: 'space' });
  for (const fn of Object.values(toast)) if (vi.isMockFunction(fn)) fn.mockClear();
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
  useCurrentUserStore.setState({ user: null });
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
      screen.getByTestId('timeline-clip-start').focus();
      expect(selected).toHaveClass('border-active-border');
    }
  });
  it('shows a short conflict status in selected properties and retains the full instruction above', async () => {
    seedConflictingClips();
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-conflict-' + CLIP.id));
    const area = within(properties());
    expect(area.getByText(t('timeline.conflict'), { exact: true })).toBeVisible();
    expect(area.queryByText(t('timeline.conflictHelp'))).toBe(null);
    expect(screen.getAllByText(t('timeline.conflictHelp')).length).toBeGreaterThan(0);
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
    write(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP }, placement: ON });
    showTimeline({ ...CONNECTED, synced: false, status: 'disconnected' });
    expect(await screen.findByTestId('timeline-clip-' + CLIP.id)).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-space-loading')).toBe(null);
  });
  it('shows a Viewer the shared clip and refuses material creation', async () => {
    const doc = seedContent();
    write(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP }, placement: ON });
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
      write(peer, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP }, placement: ON });
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
  it('uses the selected explicit integer start frame on a sub track', async () => {
    seedLayout([]);
    showTimeline();
    const user = userEvent.setup();
    await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    await user.click(screen.getByTestId('timeline-material-track'));
    await user.click(await screen.findByRole('option', { name: t('timeline.track', { index: 2 }) }));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '72' } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(1));
    expect(Object.values(layout().clips)[0]).toMatchObject({ trackId: 'v2', startFrame: 72 });
  });
  it('inserts at frame 0 on the empty magnetic main track whatever start is typed', async () => {
    seedContent();
    showTimeline();
    await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '72' } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(1));
    expect(Object.values(layout().clips)[0]).toMatchObject({ trackId: MAIN, startFrame: 0 });
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
  it('inserts before an existing main clip instead of refusing the overlapping frame', async () => {
    const doc = seedContent();
    write(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP }, placement: ON });
    showTimeline();
    await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(2));
    const main = Object.values(layout().clips).sort((left, right) => left.startFrame - right.startFrame);
    expect(main.map((item) => item.startFrame)).toEqual([0, 48]);
    expect(main[1]?.id).toBe(CLIP.id);
    expect(screen.queryByRole('dialog')).toBe(null);
  });
  it('overwrites the covered part of a sub-track clip', async () => {
    seedLayout([clipAt(CLIP.id, 'v2', 0, 48)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + CLIP.id));
    await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(2));
    expect(layout().clips[CLIP.id]).toMatchObject({ trackId: 'v2', startFrame: 0, durationFrames: 12 });
    const added = Object.values(layout().clips).find((item) => item.id !== CLIP.id);
    expect(added).toMatchObject({ trackId: 'v2', startFrame: 12, durationFrames: 48 });
  });
  it('keeps the form and names the reason when a peer removed the target track', async () => {
    const doc = seedLayout([clipAt(CLIP.id, 'v2', 0, 48)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + CLIP.id));
    const dialog = await openMaterial();
    expect(within(dialog).getByTestId('timeline-material-track')).toHaveTextContent(t('timeline.track', { index: 2 }));
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '60' } });
    act(() => {
      doc.transact(() => { doc.getMap('clips').delete(CLIP.id); doc.getMap('tracks').delete('v2'); }, 'provider');
    });
    const before = Y.encodeStateAsUpdate(doc);
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    expect(await within(dialog).findByText(t('timeline.errors.track_missing'))).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-start-frame')).toHaveValue(60);
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
    magnet(false);
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
  // Magnet off: the main track keeps the captured frame, which is what these lifecycle cases observe.
  beforeEach(() => magnet(false));
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
  it('keeps the captured sub-track upload frame when collaborative content changes meanwhile', async () => {
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    const doc = seedLayout([clipAt('30000000-0000-4000-8000-000000000009', 'v2', 0, 10)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-30000000-0000-4000-8000-000000000009'));
    await confirmLocal(72);
    act(() => { write(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: { ...CLIP, trackId: 'v2', startFrame: 20 } }, placement: OFF }); });
    await act(async () => answer.resolve(stored()));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(3));
    const uploaded = Object.values(layout().clips).find((clip) => layout().sources[clip.sourceId]?.assetId === LOCAL_ASSET.assetId);
    expect(uploaded).toMatchObject({ trackId: 'v2', startFrame: 72, durationFrames: 48 });
  });
  it('lands a captured main-track upload at its insertion point after a peer adds a clip meanwhile', async () => {
    magnet(true);
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    const doc = seedContent();
    showTimeline();
    await confirmLocal(72);
    act(() => { write(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP }, placement: ON }); });
    await act(async () => answer.resolve(stored()));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(2));
    const uploaded = Object.values(layout().clips).find((clip) => layout().sources[clip.sourceId]?.assetId === LOCAL_ASSET.assetId);
    expect(uploaded).toMatchObject({ trackId: MAIN, startFrame: 48, durationFrames: 48 });
    expect(layout().clips[CLIP.id]?.startFrame).toBe(0);
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
  /**
   * Two peers each add a clip at v2 frame 0; the merge overlaps them on the sub track.
   * @returns The second peer's clip and source.
   * @throws {Error} When a peer edit is refused.
   */
  function mergeOverlapOnSubTrack(): { otherClip: TimelineVideoClip; otherSource: TimelineVideoSource } {
    const doc = seedLayout([]);
    const first = new Y.Doc();
    const second = new Y.Doc();
    const otherClip = { ...CLIP, id: '30000000-0000-4000-8000-000000000002', sourceId: '10000000-0000-4000-8000-000000000002', trackId: 'v2' };
    const otherSource = { ...SOURCE, id: otherClip.sourceId };
    try {
      const seed = Y.encodeStateAsUpdate(doc);
      Y.applyUpdate(first, seed);
      Y.applyUpdate(second, seed);
      write(first, { operation: 'add_video', parameters: { source: SOURCE, clip: { ...CLIP, trackId: 'v2' } }, placement: OFF });
      write(second, { operation: 'add_video', parameters: { source: otherSource, clip: otherClip }, placement: OFF });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(first), 'first-peer');
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(second), 'second-peer');
      return { otherClip, otherSource };
    } finally { first.destroy(); second.destroy(); }
  }

  it('keeps both overlapping sub-track clips and permits an explicit start-frame correction', async () => {
    const { otherClip, otherSource } = mergeOverlapOnSubTrack();
    showTimeline();
    expect(await screen.findByTestId('timeline-clip-' + CLIP.id)).toBeInTheDocument();
    expect(screen.getByTestId('timeline-conflict-' + otherClip.id)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('timeline-clip-' + otherClip.id));
    commitField('timeline-clip-start', '48');
    await waitFor(() => expect(layout().clips[otherClip.id]?.startFrame).toBe(48));
    expect(layout().clips[CLIP.id]).toEqual({ ...CLIP, trackId: 'v2' });
    expect(Object.values(layout().clips)).toHaveLength(2);
    expect(layout().sources[otherSource.id]).toEqual(otherSource);
    await waitFor(() => expect(screen.queryByTestId('timeline-conflict-' + otherClip.id)).toBe(null));
  });

  it('resolves the overlap by deleting one of the clips', async () => {
    const { otherClip } = mergeOverlapOnSubTrack();
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + otherClip.id));
    fireEvent.click(screen.getByTestId('timeline-delete'));
    await waitFor(() => expect(layout().clips[otherClip.id]).toBe(undefined));
    expect(layout().clips[CLIP.id]).toEqual({ ...CLIP, trackId: 'v2' });
    expect(screen.queryByTestId('timeline-conflict-' + CLIP.id)).toBe(null);
  });

  it('shows the start frame of a clip on the magnetic main track as text with the drag hint', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + CLIP.id));
    const start = screen.getByTestId('timeline-clip-start');
    expect(start.tagName).not.toBe('INPUT');
    expect(start).toHaveTextContent('0');
    expect(screen.getByText(t('timeline.edit.magnetStartHint'))).toBeInTheDocument();
    expect(screen.getByTestId('timeline-clip-in').tagName).toBe('INPUT');
    expect(screen.getByTestId('timeline-clip-duration').tagName).toBe('INPUT');
  });

  it('keeps the start frame editable on the main track with magnet off', async () => {
    magnet(false);
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + CLIP.id));
    commitField('timeline-clip-start', '30');
    await waitFor(() => expect(layout().clips[CLIP.id]?.startFrame).toBe(30));
  });
});

const X = '30000000-0000-4000-8000-000000000011';
const Y2 = '30000000-0000-4000-8000-000000000012';

describe('TimelineSpace tracks', () => {
  it('renders one row per track with the top order first and bottom-up labels', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 0, 24)], [track(MAIN, 0), track('v2', 1), track('v3', 2)]);
    showTimeline();
    const rows = [await screen.findByTestId('timeline-track-v3'), screen.getByTestId('timeline-track-v2'), screen.getByTestId('timeline-track-visual-1')];
    for (let index = 0; index < rows.length - 1; index += 1) {
      expect(rows[index]!.compareDocumentPosition(rows[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByText(t('timeline.mainTrack'))).toBeInTheDocument();
    expect(screen.getByText(t('timeline.track', { index: 2 }))).toBeInTheDocument();
    expect(screen.getByText(t('timeline.track', { index: 3 }))).toBeInTheDocument();
    expect(screen.getByTestId('timeline-clip-' + X)).toHaveAttribute('data-track-id', 'v2');
    expect(screen.getByTestId('timeline-clip-' + CLIP.id)).toHaveAttribute('data-track-id', MAIN);
    expect(screen.getByTestId('timeline-new-track-zone')).toBeInTheDocument();
  });

  it('offers delete only on empty sub tracks and removes the track', async () => {
    seedLayout([clipAt(X, 'v2', 0, 24)], [track(MAIN, 0), track('v2', 1), track('v3', 2)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-delete-track-v3'));
    await waitFor(() => expect(layout().tracks.v3).toBe(undefined));
    expect(screen.queryByTestId('timeline-delete-track-v2')).toBe(null);
    expect(screen.queryByTestId('timeline-delete-track-' + MAIN)).toBe(null);
    expect(screen.queryByTestId('timeline-track-v3')).toBe(null);
  });

  it('shows the upper layer in the preview where tracks overlap in time', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 0, 24)]);
    showTimeline();
    await waitFor(() => expect(screen.getByTestId('timeline-preview')).toHaveAttribute('data-active-clip-id', X));
  });
});

describe('TimelineSpace toolbar', () => {
  it('disables every editing button for a Viewer and keeps the switches usable', async () => {
    seedLayout([clipAt(X, 'v2', 0, 24)]);
    showTimeline({ ...CONNECTED, writeAccess: 'denied' }, true);
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    for (const id of ['timeline-undo', 'timeline-redo', 'timeline-split', 'timeline-duplicate', 'timeline-delete']) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
    const snap = screen.getByTestId('timeline-toggle-snap');
    expect(snap).toBeEnabled();
    expect(snap).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(snap);
    expect(snap).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps clip actions reachable without a selection and explains why they do nothing', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 0, 24)]);
    const before = Y.encodeStateAsUpdate(doc);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    for (const id of ['timeline-split', 'timeline-duplicate', 'timeline-delete']) {
      const button = screen.getByTestId(id);
      expect(button).not.toBeDisabled();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      vi.mocked(toast.warning).mockClear();
      fireEvent.click(button);
      expect(vi.mocked(toast.warning).mock.calls.map(([message]) => message)).toEqual([t('timeline.edit.selectFirst')]);
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('disables undo and redo while the history is empty', async () => {
    seedLayout([clipAt(X, 'v2', 0, 24)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    expect(screen.getByTestId('timeline-undo')).toBeDisabled();
    expect(screen.getByTestId('timeline-redo')).toBeDisabled();
  });

  it('toggles magnet, snap and linkage and stores them for this account', async () => {
    seedLayout([]);
    showTimeline();
    for (const [id, key] of [['timeline-toggle-magnet', 'timelineMagnet'], ['timeline-toggle-snap', 'timelineSnap'], ['timeline-toggle-linkage', 'timelineLinkage']] as const) {
      const toggle = await screen.findByTestId(id);
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      expect(JSON.parse(window.localStorage.getItem('breatic.userPreferences') ?? '{}')[ME]?.[key]).toBe(false);
    }
  });

  it('offers a zoom slider', async () => {
    seedLayout([]);
    showTimeline();
    expect(await screen.findByTestId('timeline-zoom')).toBeInTheDocument();
  });
});

describe('TimelineSpace clip actions', () => {
  it('splits the selected clip at the playhead from the toolbar', async () => {
    magnet(false);
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + CLIP.id));
    fireEvent.keyDown(screen.getByRole('slider', { name: t('timeline.seek') }), { key: 'End' });
    await waitFor(() => expect(screen.getByText(t('timeline.framePosition', { frame: 47, total: 48 }))).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('timeline-split'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(2));
    const parts = Object.values(layout().clips).sort((left, right) => left.startFrame - right.startFrame);
    expect(parts.map((item) => [item.startFrame, item.durationFrames, item.sourceInFrame])).toEqual([[0, 47, 0], [47, 1, 47]]);
    expect(new Set(parts.map((item) => item.sourceId)).size).toBe(1);
    expect(parts[0]?.id).toBe(CLIP.id);
  });

  it.each([['Cmd', { metaKey: true }], ['Ctrl', { ctrlKey: true }]] as const)('splits with %s+B', async (_name, mod) => {
    seedLayout([clipAt(X, 'v2', 0, 24)]);
    showTimeline();
    fireEvent.keyDown(screen.getByRole('slider', { name: t('timeline.seek') }), { key: 'End' });
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    press(clip, 'b', mod);
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(2));
  });

  it('warns and writes nothing when the playhead is outside the selected clip', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    const before = Y.encodeStateAsUpdate(doc);
    press(clip, 'b', { ctrlKey: true });
    expect(toast.warning).toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each([['toolbar', null], ['Cmd+D', { metaKey: true }], ['Ctrl+D', { ctrlKey: true }]] as const)('duplicates after the original from the %s and selects the copy', async (_name, mod) => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + CLIP.id);
    fireEvent.click(clip);
    if (mod === null) fireEvent.click(screen.getByTestId('timeline-duplicate'));
    else press(clip, 'd', mod);
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(2));
    const copy = Object.values(layout().clips).find((item) => item.id !== CLIP.id);
    expect(copy).toMatchObject({ trackId: MAIN, startFrame: 48, durationFrames: 48, sourceId: SOURCE.id });
    await waitFor(() => expect(screen.getByTestId('timeline-clip-' + copy?.id)).toHaveAttribute('aria-pressed', 'true'));
  });

  it.each([['toolbar', null], ['Delete', 'Delete'], ['Backspace', 'Backspace']] as const)('deletes from the %s and keeps the source', async (_name, key) => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + CLIP.id);
    fireEvent.click(clip);
    if (key === null) fireEvent.click(screen.getByTestId('timeline-delete'));
    else press(clip, key);
    await waitFor(() => expect(layout().clips[CLIP.id]).toBe(undefined));
    expect(layout().sources[SOURCE.id]).toEqual(SOURCE);
    expect(screen.getByText(t('timeline.selectClip'))).toBeInTheDocument();
  });

  it('undoes and redoes from the toolbar', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + CLIP.id));
    fireEvent.click(screen.getByTestId('timeline-delete'));
    await waitFor(() => expect(layout().clips[CLIP.id]).toBe(undefined));
    expect(screen.getByTestId('timeline-undo')).toBeEnabled();
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[CLIP.id]).toMatchObject({ startFrame: 0, durationFrames: 48 }));
    expect(screen.getByTestId('timeline-redo')).toBeEnabled();
    fireEvent.click(screen.getByTestId('timeline-redo'));
    await waitFor(() => expect(layout().clips[CLIP.id]).toBe(undefined));
  });

  it.each([
    ['Cmd', { metaKey: true }, { metaKey: true, shiftKey: true }, 'z'],
    ['Ctrl', { ctrlKey: true }, { ctrlKey: true, shiftKey: true }, 'z'],
    ['Ctrl+Y', { ctrlKey: true }, { ctrlKey: true }, 'y'],
  ] as const)('undoes and redoes with %s', async (_name, undoMod, redoMod, redoKey) => {
    seedLayout([clipAt(X, 'v2', 0, 24)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    press(clip, 'Delete');
    await waitFor(() => expect(layout().clips[X]).toBe(undefined));
    const root = screen.getByTestId('timeline-space');
    press(root, 'z', undoMod);
    await waitFor(() => expect(layout().clips[X]).toMatchObject({ startFrame: 0 }));
    press(root, redoKey, redoMod);
    await waitFor(() => expect(layout().clips[X]).toBe(undefined));
  });

  it('nudges a sub-track clip one frame, one second with Shift, and merges a held key into one undo', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    press(clip, 'ArrowRight');
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(11));
    press(clip, 'ArrowRight', { shiftKey: true });
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(35));
    press(clip, 'ArrowLeft');
    press(clip, 'ArrowLeft', { repeat: true });
    press(clip, 'ArrowLeft', { repeat: true });
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(32));
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(35));
  });

  it('moves the playhead with arrows when nothing is selected', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 0, 48)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    const before = Y.encodeStateAsUpdate(doc);
    press(screen.getByTestId('timeline-space'), 'ArrowRight', { shiftKey: true });
    await waitFor(() => expect(screen.getByText(t('timeline.framePosition', { frame: 24, total: 48 }))).toBeInTheDocument());
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('swaps with the neighbour on the magnetic main track and reports a linkage bump', async () => {
    const A = '30000000-0000-4000-8000-000000000021';
    const B = '30000000-0000-4000-8000-000000000022';
    const Z = '30000000-0000-4000-8000-000000000023';
    seedLayout([clipAt(A, MAIN, 0, 20), clipAt(B, MAIN, 20, 28), clipAt(X, 'v2', 10, 30, { sourceInFrame: 0 }), clipAt(Z, 'v2', 48, 10)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + A);
    fireEvent.click(clip);
    press(clip, 'ArrowRight');
    await waitFor(() => expect(layout().clips[A]?.startFrame).toBe(28));
    expect(layout().clips[B]?.startFrame).toBe(0);
    expect(layout().clips[X]?.trackId).not.toBe('v2');
    expect(vi.mocked(toast.info).mock.calls.map(([message]) => message)).toContain(t('timeline.edit.bumped', { count: 1 }));
  });

  it('moves the selected clip up into a new track with Alt+Up on the top track', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    press(clip, 'ArrowUp', { altKey: true });
    await waitFor(() => expect(Object.keys(layout().tracks)).toHaveLength(3));
    const moved = layout().clips[X];
    expect(moved?.startFrame).toBe(10);
    expect(layout().tracks[moved?.trackId ?? '']).toMatchObject({ kind: 'visual', order: 2 });
  });

  it('toggles snapping with N', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const toggle = await screen.findByTestId('timeline-toggle-snap');
    press(screen.getByTestId('timeline-space'), 'n');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('leaves keys to an input that has focus', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const duration = screen.getByTestId('timeline-clip-duration');
    press(duration, 'Delete');
    press(duration, 'ArrowRight');
    expect(layout().clips[X]).toMatchObject({ startFrame: 10, durationFrames: 14 });
  });

  it('leaves arrow keys to the focused seek slider', async () => {
    seedLayout([clipAt(X, 'v2', 10, 30)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    press(screen.getByRole('slider', { name: t('timeline.seek') }), 'ArrowRight');
    await waitFor(() => expect(screen.getByText(t('timeline.framePosition', { frame: 1, total: 40 }))).toBeInTheDocument());
    expect(layout().clips[X]?.startFrame).toBe(10);
  });
});

describe('TimelineSpace properties', () => {
  it('commits start, in-point and duration on Enter', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    commitField('timeline-clip-start', '30');
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(30));
    commitField('timeline-clip-in', '4');
    await waitFor(() => expect(layout().clips[X]?.sourceInFrame).toBe(4));
    commitField('timeline-clip-duration', '20');
    await waitFor(() => expect(layout().clips[X]).toMatchObject({ startFrame: 30, sourceInFrame: 4, durationFrames: 20 }));
  });

  it.each([['duration', 'timeline-clip-duration', '0'], ['duration past the source', 'timeline-clip-duration', '49'], ['in-point past the source', 'timeline-clip-in', '40'], ['negative start', 'timeline-clip-start', '-1']])(
    'shows the range error next to the field and keeps the draft for %s',
    async (_name, testId, value) => {
      const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
      showTimeline();
      fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
      const before = Y.encodeStateAsUpdate(doc);
      commitField(testId, value);
      expect(await screen.findByTestId('timeline-clip-field-error')).toHaveTextContent(t('timeline.errors.invalid_range'));
      expect((screen.getByTestId(testId) as HTMLInputElement).value).toBe(value);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    },
  );

  it('moves the selected clip to another track and to a new track from the track select', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const user = userEvent.setup();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    expect(screen.getByTestId('timeline-clip-track')).toHaveTextContent(t('timeline.track', { index: 2 }));
    await user.click(screen.getByTestId('timeline-clip-track'));
    await user.click(await screen.findByRole('option', { name: t('timeline.edit.newTrack') }));
    await waitFor(() => expect(Object.keys(layout().tracks)).toHaveLength(3));
    const created = layout().clips[X]?.trackId ?? '';
    expect(layout().tracks[created]).toMatchObject({ kind: 'visual', order: 2 });
    expect(layout().clips[X]?.startFrame).toBe(10);
    await user.click(screen.getByTestId('timeline-clip-track'));
    await user.click(await screen.findByRole('option', { name: t('timeline.mainTrack') }));
    await waitFor(() => expect(layout().clips[X]?.trackId).toBe(MAIN));
  });

  it('names a removed track in the track select', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    act(() => { doc.transact(() => doc.getMap('tracks').delete('v2'), 'provider'); });
    await waitFor(() => expect(screen.getByTestId('timeline-clip-track')).toHaveTextContent(t('timeline.edit.trackRemoved')));
  });

  it('clears the properties when a peer deletes the selected clip', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    act(() => { write(doc, { operation: 'delete', parameters: { clipId: X }, placement: OFF }); });
    await waitFor(() => expect(screen.getByText(t('timeline.selectClip'))).toBeInTheDocument());
    expect(screen.queryByTestId('timeline-clip-start')).toBe(null);
  });
});

describe('TimelineSpace selection and editing affordances', () => {
  it('shows trim handles on the selected clip for an editor', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14), clipAt(Y2, 'v2', 30, 10)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    expect(screen.getByTestId('timeline-clip-' + X)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('timeline-trim-start-' + X)).toBeInTheDocument();
    expect(screen.getByTestId('timeline-trim-end-' + X)).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-trim-start-' + Y2)).toBe(null);
  });

  it('lets a Viewer select and read properties without any editing affordance', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)], [track(MAIN, 0), track('v2', 1), track('v3', 2)]);
    const before = Y.encodeStateAsUpdate(doc);
    showTimeline({ ...CONNECTED, writeAccess: 'denied' }, true);
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    expect(clip).toHaveAttribute('aria-pressed', 'true');
    for (const id of ['timeline-clip-start', 'timeline-clip-in', 'timeline-clip-duration']) {
      expect(screen.getByTestId(id).tagName).not.toBe('INPUT');
    }
    expect(screen.getByTestId('timeline-clip-start')).toHaveTextContent('10');
    expect(screen.queryByTestId('timeline-trim-start-' + X)).toBe(null);
    expect(screen.queryByTestId('timeline-trim-end-' + X)).toBe(null);
    expect(screen.queryByTestId('timeline-new-track-zone')).toBe(null);
    expect(screen.queryByTestId('timeline-delete-track-v3')).toBe(null);
    press(clip, 'Delete');
    press(clip, 'd', { metaKey: true });
    press(clip, 'ArrowRight');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe('TimelineSpace add dialog targets', () => {
  it('defaults to the main track and the Timeline end over all tracks', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 100, 30)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + CLIP.id);
    const dialog = await openMaterial();
    expect(within(dialog).getByTestId('timeline-material-track')).toHaveTextContent(t('timeline.mainTrack'));
    expect(within(dialog).getByTestId('timeline-start-frame')).toHaveValue(130);
  });

  it('defaults to the selected clip\'s track', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 100, 30)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const dialog = await openMaterial();
    expect(within(dialog).getByTestId('timeline-material-track')).toHaveTextContent(t('timeline.track', { index: 2 }));
  });

  it('hints where the clip goes on the magnetic main track and follows the typed start', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + CLIP.id);
    const dialog = await openMaterial();
    await waitFor(() => expect(within(dialog).getByTestId('timeline-material-insert-hint')).toHaveTextContent(t('timeline.material.insertAfter', { name: ASSET.displayName ?? '' })));
    fireEvent.change(within(dialog).getByTestId('timeline-start-frame'), { target: { value: '10' } });
    expect(within(dialog).getByTestId('timeline-material-insert-hint')).toHaveTextContent(t('timeline.material.insertFirst'));
  });

  it('shows no insert hint for a sub track', async () => {
    seedLayout([clipAt(X, 'v2', 0, 30)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const dialog = await openMaterial();
    expect(within(dialog).getByTestId('timeline-material-track')).toHaveTextContent(t('timeline.track', { index: 2 }));
    expect(within(dialog).queryByTestId('timeline-material-insert-hint')).toBe(null);
  });

  it('adds onto a new visual track chosen in the dialog', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    const user = userEvent.setup();
    await screen.findByTestId('timeline-clip-' + CLIP.id);
    await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    await user.click(screen.getByTestId('timeline-material-track'));
    await user.click(await screen.findByRole('option', { name: t('timeline.edit.newTrack') }));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(2));
    const added = Object.values(layout().clips).find((item) => item.id !== CLIP.id);
    expect(added?.startFrame).toBe(12);
    expect(layout().tracks[added?.trackId ?? '']).toMatchObject({ kind: 'visual', order: 2 });
    expect(layout().clips[CLIP.id]?.startFrame).toBe(0);
  });

  it('can undo an addition', async () => {
    seedContent();
    showTimeline();
    await addProjectVideo();
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(1));
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(0));
    expect(Object.values(layout().sources)).toHaveLength(1);
  });
});
