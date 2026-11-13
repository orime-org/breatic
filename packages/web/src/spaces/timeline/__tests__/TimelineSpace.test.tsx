// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  t, type ProjectRegisteredAsset, type TimelineDocumentV1, type TimelineTrack,
  type TimelineVideoClip, type TimelineVideoSource, TIMELINE_PREVIEW_DEFAULTS,
} from '@breatic/shared';
import type { TimelineEditCommand } from '@web/data/yjs/timeline-edit';
import { initializeTimelineDocument } from '@breatic/shared/space-content';
import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { UploadFailedError, uploadMedia, type StoredUpload } from '@web/data/upload/media-upload';
import type * as MediaUploadModule from '@web/data/upload/media-upload';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { SIZE_COPY_EN, enterSize } from '@web/data/yjs/__tests__/helpers/size-v2-harness';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import { toast } from '@web/lib/toast';
import { writeUserPreference } from '@web/lib/user-preferences-storage';
import { useCurrentUserStore, useUIStore } from '@web/stores';
import { MAIN, clip as clipAt, seededDoc, sourceIdOf, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import type { SocketState } from '@web/data/yjs/use-socket';
import { TimelineSpace } from '@web/spaces/timeline/TimelineSpace';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { useTimelineEditPrefsStore } from '@web/stores/timeline-edit-prefs';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';
import { formatShortcut } from '@web/spaces/canvas/format-shortcut';
import { gesture, moveableMock, resetMoveableMock } from '@web/spaces/timeline/__tests__/helpers/moveable-mock';
import { timelineAssetKey } from '@web/spaces/timeline/use-timeline-asset';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, listVideos: vi.fn(), resolveAsset: vi.fn(), limits: vi.fn() } };
});
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('react-moveable', async () => (await import('@web/spaces/timeline/__tests__/helpers/moveable-mock')).moveableModule);
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
  transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};
const ME = 'user-timeline-editor';
const ON = { magnet: true, linkage: true } as const;
const OFF = { magnet: false, linkage: false } as const;
const CONNECTED: SocketState = {
  provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null,
};
const clients: QueryClient[] = [];

/**
 * A frame count as the Timeline shows it, HH:MM:SS:FF at the 24 fps of these fixtures; written out here so the
 * expectation does not come from the code under test.
 * @param frame - Frames.
 * @returns The timecode text.
 * @throws {never} Never.
 */
function timecode(frame: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const seconds = Math.floor(frame / 24);
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}:${pad(frame % 24)}`;
}

/**
 * The play bar's position text.
 * @param frame - The playhead frame.
 * @param total - The sequence length.
 * @returns The text.
 * @throws {never} Never.
 */
function position(frame: number, total: number): string {
  return `${timecode(frame)} / ${timecode(total)}`;
}

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
 * The preview's video element of one clip (breatic#1410 design §6.1: each carries `data-clip-id`).
 * @param clipId - The clip.
 * @returns The element.
 * @throws {Error} When the preview draws no video for it.
 */
function previewVideo(clipId: string): HTMLVideoElement {
  const video = screen.getByTestId('timeline-preview').querySelector<HTMLVideoElement>(`video[data-clip-id="${clipId}"]`);
  if (video === null) throw new Error(`No preview video for ${clipId}`);
  return video;
}

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
  useTimelineEditPrefsStore.setState({ owner: null });
  useCurrentUserStore.setState({ user: { id: ME, name: 'Me', email: 'me@e.com', personalStudio: { name: 'Me', slug: 'me', avatarUrl: null }, membershipTier: 'base' } });
  useUIStore.setState({ activeRegion: 'space' });
  for (const fn of Object.values(toast)) if (vi.isMockFunction(fn)) fn.mockClear();
  useSpaceOperationsStore.setState({ operations: {} });
  vi.mocked(timelineApi.listVideos).mockReset().mockResolvedValue({ items: [ASSET], nextCursor: null });
  vi.mocked(timelineApi.resolveAsset).mockReset().mockImplementation(async (_projectId, assetId) => assetId === LOCAL_ASSET.assetId ? LOCAL_ASSET : ASSET);
  vi.mocked(timelineApi.limits).mockReset().mockResolvedValue({
    defaults: SETTINGS, assets: { pageSize: 50, pageMax: 100 },
    webAnimation: { promptMaxLength: 4000, durationSeconds: { min: 1, max: 60, default: 4 }, aspects: ['16:9', '9:16', '1:1'], playerLoadTimeoutMs: 15000, sourceRefreshIntervalMs: 10000 },
    preview: TIMELINE_PREVIEW_DEFAULTS,
  });
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
    currentDoc().getMap('timeline').set('schemaVersion', 3);
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
    expect(clip).toEqual({ ...CLIP, id: clip?.id, sourceId: sourceIdOf(clip) });
    expect(Object.values(data.sources)).toHaveLength(1);
    expect(data.sources[sourceIdOf(clip) ?? '']).toEqual({ ...SOURCE, id: sourceIdOf(clip) });
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
      ...SOURCE, id: sourceIdOf(clip), durationOrigin: 'decoded', durationSeconds: '1.25', extentFrames: 30,
    }]);
    expect(asset.durationSeconds).toBe(null);
    expect(second.getAttribute('src')).toBe(null);
    expect(screen.queryByRole('dialog')).toBe(null);
  });
});

describe('TimelineSpace local uploads in the background', () => {
  /**
   * Answer the duration read of a local file's object URL as the browser would.
   * @param seconds - The duration its metadata reports, or null when the browser cannot read it.
   */
  function localMetadata(seconds: number | null): void {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:local-video'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function load(this: HTMLMediaElement) {
      if (this.getAttribute('src') !== 'blob:local-video') return;
      if (seconds !== null) Object.defineProperty(this, 'duration', { configurable: true, value: seconds });
      queueMicrotask(() => this.dispatchEvent(new Event(seconds === null ? 'error' : 'loadedmetadata')));
    });
  }

  /**
   * The one clip of the layout.
   * @returns It.
   * @throws {Error} When the layout does not hold exactly one clip.
   */
  function onlyClip(): TimelineDocumentV1['clips'][string] {
    const clips = Object.values(layout().clips);
    if (clips.length !== 1) throw new Error(`Expected one clip, got ${clips.length}`);
    return clips[0]!;
  }

  beforeEach(() => {
    magnet(false);
    localMetadata(2);
  });

  it('places a confirmed local video at once as a placeholder, closes the dialog and uploads it to this Space', async () => {
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    seedContent();
    showTimeline();
    const file = await confirmLocal(72);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null));
    expect(onlyClip()).toMatchObject({ kind: 'upload', trackId: MAIN, startFrame: 72, durationFrames: 48, upload: { name: 'Local video.mp4', durationSeconds: 2 } });
    expect(vi.mocked(uploadMedia).mock.calls[0]?.slice(0, 2)).toEqual([file, { projectId: PROJECT, spaceId: SPACE }]);
    await waitFor(() => expect(useSpaceOperationsStore.getState().hasOperations(SPACE)).toBe(true));
    expect(screen.getByTestId(`timeline-clip-${onlyClip().id}`)).toHaveAttribute('data-state', 'uploading');
  });

  it('turns the placeholder into the registered video while the Space is hidden, without an undo step', async () => {
    const answer = deferred<StoredUpload>();
    vi.mocked(uploadMedia).mockReturnValueOnce(answer.promise);
    seedContent();
    const { view, client } = showTimeline(CONNECTED, false, 'visible');
    await confirmLocal(72);
    const { id } = onlyClip();
    view.rerender(<React.Activity mode='hidden'>{surface(client)}</React.Activity>);
    await act(async () => answer.resolve(stored()));
    await waitFor(() => expect(onlyClip().kind).toBe('video'));
    expect(onlyClip()).toMatchObject({ id, trackId: MAIN, startFrame: 72, durationFrames: 48 });
    expect(layout().sources[sourceIdOf(onlyClip()) ?? '']?.assetId).toBe(LOCAL_ASSET.assetId);
    await waitFor(() => expect(useSpaceOperationsStore.getState().hasOperations(SPACE)).toBe(false));
    view.rerender(<React.Activity mode='visible'>{surface(client)}</React.Activity>);
    expect(await screen.findByTestId(`timeline-clip-${id}`)).toHaveAttribute('data-kind', 'video');
  });

  it('lands a main-track placeholder at its insertion point with the magnet on', async () => {
    magnet(true);
    const doc = seedContent();
    act(() => { write(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP }, placement: ON }); });
    vi.mocked(uploadMedia).mockReturnValueOnce(deferred<StoredUpload>().promise);
    showTimeline();
    await confirmLocal(72);
    const placeholder = Object.values(layout().clips).find((clip) => clip.kind === 'upload');
    expect(placeholder).toMatchObject({ trackId: MAIN, startFrame: 48, durationFrames: 48 });
    expect(layout().clips[CLIP.id]?.startFrame).toBe(0);
  });

  it('stays in the dialog with the duration error when the browser cannot read the file', async () => {
    localMetadata(null);
    seedContent();
    showTimeline();
    await openMaterial();
    fireEvent.click(screen.getByTestId('timeline-material-local'));
    fireEvent.change(screen.getByTestId('timeline-file-input'), { target: { files: [new File(['x'], 'broken.mp4', { type: 'video/mp4' })] } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    expect(await screen.findByTestId('timeline-material-error')).toHaveTextContent(t('timeline.errors.metadata_unavailable'));
    expect(Object.keys(layout().clips)).toEqual([]);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('keeps a failed placeholder and lets its uploader retry the same file', async () => {
    vi.mocked(uploadMedia).mockRejectedValueOnce(new UploadFailedError('transfer')).mockReturnValueOnce(deferred<StoredUpload>().promise);
    seedContent();
    showTimeline();
    const file = await confirmLocal();
    const { id } = onlyClip();
    await waitFor(() => expect(screen.getByTestId(`timeline-clip-${id}`)).toHaveAttribute('data-state', 'failed'));
    // The preview draws nothing for the placeholder at the playhead and notes it by track (design §4.3).
    const note = (state: string): string => t('timeline.upload.preview', { track: t('timeline.mainTrack'), state });
    expect(screen.getByTestId(`timeline-preview-note-${id}`)).toHaveTextContent(note('failed'));
    fireEvent.click(screen.getByTestId(`timeline-clip-${id}`));
    fireEvent.click(await screen.findByTestId('timeline-upload-retry'));
    await waitFor(() => expect(vi.mocked(uploadMedia).mock.calls.map(([sent]) => sent)).toEqual([file, file]));
    await waitFor(() => expect(screen.getByTestId(`timeline-clip-${id}`)).toHaveAttribute('data-state', 'uploading'));
    expect(screen.getByTestId(`timeline-preview-note-${id}`)).toHaveTextContent(note('uploading'));
  });

  it('offers no retry when sending the same file again cannot help', async () => {
    vi.mocked(uploadMedia).mockRejectedValueOnce(new UploadFailedError('tooLarge'));
    seedContent();
    showTimeline();
    await confirmLocal();
    const { id } = onlyClip();
    await waitFor(() => expect(screen.getByTestId(`timeline-clip-${id}`)).toHaveAttribute('data-state', 'failed'));
    fireEvent.click(screen.getByTestId(`timeline-clip-${id}`));
    expect(await screen.findByTestId('timeline-clip-upload')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-upload-retry')).toBe(null);
  });

  it('draws an uploading placeholder as a dashed card slot and its uploader\'s progress as a bar (visual #2, #3)', async () => {
    let report: ((share: number) => void) | undefined;
    vi.mocked(uploadMedia).mockImplementationOnce((_file, _context, onProgress) => { report = onProgress; return deferred<StoredUpload>().promise; });
    seedContent();
    showTimeline();
    await confirmLocal();
    const { id } = onlyClip();
    const clip = screen.getByTestId(`timeline-clip-${id}`);
    expect(clip).toHaveClass('bg-card', 'border-dashed');
    expect(clip.className).not.toContain('palette-blue');
    fireEvent.click(clip);
    expect(clip.className).not.toContain('palette-blue');
    expect(screen.queryByTestId('timeline-upload-progress')).toBe(null);
    act(() => report?.(0.42));
    expect(await screen.findByTestId('timeline-upload-progress')).toHaveAttribute('aria-valuenow', '42');
  });

  it('draws a placeholder nobody uploads any more as a dashed muted slot (visual #1)', () => {
    const doc = seedContent();
    const { sourceId: _sourceId, ...placement } = CLIP;
    act(() => { write(doc, { operation: 'add_upload', parameters: { clip: { ...placement, kind: 'upload', upload: { uploadId: '40000000-0000-4000-8000-000000000001', name: 'left.mp4', durationSeconds: 2 } } }, placement: OFF }); });
    showTimeline();
    const clip = screen.getByTestId(`timeline-clip-${CLIP.id}`);
    expect(clip).toHaveAttribute('data-state', 'unfinished');
    expect(clip).toHaveClass('bg-muted', 'border-dashed');
    expect(clip.className).not.toContain('palette-blue');
  });

  it('keeps a failed placeholder\'s track line short and names the reason in its properties (visual #4)', async () => {
    vi.mocked(uploadMedia).mockRejectedValueOnce(new UploadFailedError('tooLarge'));
    seedContent();
    showTimeline();
    await confirmLocal();
    const { id } = onlyClip();
    const clip = screen.getByTestId(`timeline-clip-${id}`);
    await waitFor(() => expect(clip).toHaveAttribute('data-state', 'failed'));
    expect(clip).toHaveTextContent(t('timeline.upload.failed'));
    expect(clip).not.toHaveTextContent('exceeds');
    fireEvent.click(clip);
    expect(await screen.findByTestId('timeline-clip-upload')).toHaveTextContent('Local video.mp4');
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

  it('draws every overlapping video in the preview, stacked by track with the upper layer on top (breatic#1410 §6.1)', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 0, 24)]);
    showTimeline();
    const preview = screen.getByTestId('timeline-preview');
    const upper = await waitFor(() => previewVideo(X));
    const lower = previewVideo(CLIP.id);
    expect(Number(upper.style.zIndex)).toBeGreaterThan(Number(lower.style.zIndex));
    expect(preview.querySelectorAll('video')).toHaveLength(2);
    expect(preview.hasAttribute('data-active-clip-id')).toBe(false);
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
    await waitFor(() => expect(screen.getByText(position(47, 48))).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('timeline-split'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(2));
    const parts = Object.values(layout().clips).sort((left, right) => left.startFrame - right.startFrame);
    expect(parts.map((item) => [item.startFrame, item.durationFrames, item.sourceInFrame])).toEqual([[0, 47, 0], [47, 1, 47]]);
    expect(new Set(parts.map((item) => sourceIdOf(item))).size).toBe(1);
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

  it.each([['toolbar', null], ['Delete', 'Delete'], ['Backspace', 'Backspace']] as const)('deletes from the %s and drops the source no clip references any more (inner#1708 L2)', async (_name, key) => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + CLIP.id);
    fireEvent.click(clip);
    if (key === null) fireEvent.click(screen.getByTestId('timeline-delete'));
    else press(clip, key);
    await waitFor(() => expect(layout().clips[CLIP.id]).toBe(undefined));
    expect(layout().sources).toEqual({});
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
    await waitFor(() => expect(screen.getByText(position(24, 48))).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText(position(1, 40))).toBeInTheDocument());
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
    // The addition wrote its source, so undoing it removes that source too (inner#1708 L5).
    expect(Object.values(layout().sources)).toHaveLength(0);
  });
});

/**
 * Send one primary-button pointer event at a horizontal position, as dnd-kit's pointer sensor reads it.
 * @param target - The element pressed, or the document the sensor listens on after the press.
 * @param type - The pointer event.
 * @param clientX - The horizontal viewport position.
 * @throws {Error} When a handler throws.
 */
function pointer(target: Element | Document, type: 'pointerDown' | 'pointerMove' | 'pointerUp', clientX: number): void {
  fireEvent[type](target, { clientX, clientY: 10, isPrimary: true, button: 0, buttons: type === 'pointerUp' ? 0 : 1, pointerId: 1 });
}

/**
 * The drag preview outline drawn on a track row, if any.
 * @param trackId - The row's track.
 * @returns The outline, or null.
 * @throws {Error} When the row is absent.
 */
function dragGhost(trackId: string): Element | null {
  return screen.getByTestId(`timeline-track-${trackId}`).querySelector('.pointer-events-none.rounded-chrome:not([data-testid])');
}

describe('TimelineSpace keyboard focus and selection (inner#1708 G1, G3, C1, C5)', () => {
  it('selects a clip when it receives focus, so Delete removes the focused clip and keeps the earlier one', async () => {
    seedLayout([clipAt(X, 'v2', 0, 10), clipAt(Y2, 'v2', 20, 10)]);
    showTimeline();
    const first = await screen.findByTestId('timeline-clip-' + X);
    const second = screen.getByTestId('timeline-clip-' + Y2);
    fireEvent.click(first);
    act(() => second.focus());
    expect(second).toHaveAttribute('aria-pressed', 'true');
    expect(first).toHaveAttribute('aria-pressed', 'false');
    press(second, 'Delete');
    await waitFor(() => expect(layout().clips[Y2]).toBe(undefined));
    expect(layout().clips[X]).toMatchObject({ startFrame: 0, durationFrames: 10 });
  });

  it('leaves a typed key to the focused track select', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const select = screen.getByTestId('timeline-clip-track');
    expect(select).toHaveAttribute('role', 'combobox');
    press(select, 'n');
    expect(screen.getByTestId('timeline-toggle-snap')).toHaveAttribute('aria-pressed', 'true');
  });

  it('undoes a keyboard delete with Cmd+Z after focus fell back to the page', async () => {
    seedLayout([clipAt(X, 'v2', 0, 24)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    press(clip, 'Delete');
    await waitFor(() => expect(layout().clips[X]).toBe(undefined));
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    await waitFor(() => expect(layout().clips[X]).toMatchObject({ startFrame: 0, durationFrames: 24 }));
  });

  it('keeps Alt+Up working after a track change dropped the focus', async () => {
    seedLayout([clipAt(X, MAIN, 0, 24)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    press(clip, 'ArrowUp', { altKey: true });
    await waitFor(() => expect(layout().clips[X]?.trackId).toBe('v2'));
    const target = document.activeElement ?? document.body;
    fireEvent.keyDown(target, { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(Object.keys(layout().tracks)).toHaveLength(3));
    expect(layout().tracks[layout().clips[X]?.trackId ?? '']).toMatchObject({ order: 2 });
  });

  it('undoes a held main-track nudge in one step', async () => {
    const A = '30000000-0000-4000-8000-000000000031';
    const B = '30000000-0000-4000-8000-000000000032';
    const C = '30000000-0000-4000-8000-000000000033';
    const D = '30000000-0000-4000-8000-000000000034';
    seedLayout([clipAt(A, MAIN, 0, 10), clipAt(B, MAIN, 10, 10), clipAt(C, MAIN, 20, 10), clipAt(D, MAIN, 30, 10)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + A);
    fireEvent.click(clip);
    press(clip, 'ArrowRight');
    await waitFor(() => expect(layout().clips[A]?.startFrame).toBe(10));
    press(screen.getByTestId('timeline-clip-' + A), 'ArrowRight', { repeat: true });
    await waitFor(() => expect(layout().clips[A]?.startFrame).toBe(20));
    press(screen.getByTestId('timeline-clip-' + A), 'ArrowRight', { repeat: true });
    await waitFor(() => expect(layout().clips[A]?.startFrame).toBe(30));
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[A]?.startFrame).toBe(0));
    expect([B, C, D].map((id) => layout().clips[id]?.startFrame)).toEqual([10, 20, 30]);
  });
});

describe('TimelineSpace empty-lane press (inner#1708 D1)', () => {
  it('clears the selection on a press in an empty part of a lane, so arrows move the playhead', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    const lane = screen.getByTestId('timeline-lane-v2');
    expect(lane).toContainElement(clip);
    // A press on the clip itself keeps it selected.
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerUp', 0);
    expect(clip).toHaveAttribute('aria-pressed', 'true');
    const before = Y.encodeStateAsUpdate(doc);
    pointer(lane, 'pointerDown', 200);
    pointer(document, 'pointerUp', 200);
    await waitFor(() => expect(screen.getByTestId('timeline-clip-' + X)).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.getByText(t('timeline.selectClip'))).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-clip-start')).toBe(null);
    press(screen.getByTestId('timeline-space'), 'ArrowRight');
    await waitFor(() => expect(screen.getByText(position(1, 24))).toBeInTheDocument());
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe('TimelineSpace round-three review fixes (inner#1708 E1, E2, E4)', () => {
  it('reports a linkage bump caused by adding media to the magnetic main track (E1)', async () => {
    const A = '30000000-0000-4000-8000-000000000051';
    const B = '30000000-0000-4000-8000-000000000052';
    const T = '30000000-0000-4000-8000-000000000053';
    const U = '30000000-0000-4000-8000-000000000054';
    // T starts inside B, so it moves with B; the 48-frame insert at 0 pushes it onto U, which no main clip holds.
    seedLayout([clipAt(A, MAIN, 0, 20), clipAt(B, MAIN, 20, 20), clipAt(T, 'v2', 30, 18), clipAt(U, 'v2', 80, 10)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + A);
    await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(5));
    expect(layout().clips[A]?.startFrame).toBe(48);
    expect(layout().clips[T]?.startFrame).toBe(78);
    expect(layout().clips[T]?.trackId).not.toBe('v2');
    await waitFor(() => expect(vi.mocked(toast.info).mock.calls.map(([message]) => message)).toContain(t('timeline.edit.bumped', { count: 1 })));
  });

  it('commits a typed start frame when the user presses an empty part of the lane (E2)', async () => {
    const user = userEvent.setup();
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const field = await screen.findByTestId('timeline-clip-start');
    await user.clear(field);
    await user.type(field, '30');
    expect(field).toHaveValue(30);
    expect(layout().clips[X]?.startFrame).toBe(10);
    await user.pointer({ keys: '[MouseLeft]', target: screen.getByTestId('timeline-lane-v2') });
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(30));
    await waitFor(() => expect(screen.queryByTestId('timeline-clip-start')).toBe(null));
    expect(screen.getByTestId('timeline-clip-' + X)).toHaveAttribute('aria-pressed', 'false');
  });

  it('creates one track for a held Alt+Up on the top track and undoes the hold in one step (E4)', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    press(clip, 'ArrowUp', { altKey: true });
    await waitFor(() => expect(Object.keys(layout().tracks)).toHaveLength(3));
    const created = layout().clips[X]?.trackId ?? '';
    expect(created).not.toBe('v2');
    for (let repeat = 0; repeat < 4; repeat += 1) fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowUp', altKey: true, repeat: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Object.keys(layout().tracks)).toHaveLength(3);
    expect(layout().clips[X]?.trackId).toBe(created);
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[X]?.trackId).toBe('v2'));
  });

  it('climbs existing tracks while Alt+Up is held and undoes the hold in one step (E4)', async () => {
    seedLayout([clipAt(X, MAIN, 0, 24)], [track(MAIN, 0), track('v2', 1), track('v3', 2)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    press(clip, 'ArrowUp', { altKey: true });
    await waitFor(() => expect(layout().clips[X]?.trackId).toBe('v2'));
    for (let repeat = 0; repeat < 2; repeat += 1) {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowUp', altKey: true, repeat: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await waitFor(() => expect(layout().clips[X]?.trackId).toBe('v3'));
    expect(Object.keys(layout().tracks)).toHaveLength(3);
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[X]?.trackId).toBe(MAIN));
  });
});

describe('TimelineSpace drags (inner#1708 G8, G5, C4)', () => {
  it('cancels a drag on Escape without writing (inner#1708 T2)', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    const before = Y.encodeStateAsUpdate(doc);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 40);
    expect(dragGhost('v2')).not.toBe(null);
    act(() => { fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' }); });
    expect(dragGhost('v2')).toBe(null);
    pointer(document, 'pointerUp', 40);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(layout().clips[X]?.startFrame).toBe(10);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('draws no drag preview once the role turns Viewer during a drag', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    const { view, client } = showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 20);
    expect(dragGhost('v2')).not.toBe(null);
    view.rerender(surface(client, { ...CONNECTED, writeAccess: 'denied' }, true));
    expect(dragGhost('v2')).toBe(null);
    pointer(document, 'pointerMove', 40);
    expect(dragGhost('v2')).toBe(null);
    pointer(document, 'pointerUp', 40);
  });

  it.each([
    ['move', (): HTMLElement => screen.getByTestId('timeline-clip-' + X)],
    ['trim', (): HTMLElement => screen.getByTestId('timeline-trim-end-' + X)],
  ] as const)('keeps a %s drag cancelled when write access returns before release (inner#1708 G1)', async (kind, grip) => {
    writeUserPreference(ME, { timelineSnap: false });
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    const { view, client } = showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const before = Y.encodeStateAsUpdate(doc);
    pointer(grip(), 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 20);
    expect(dragGhost('v2')).not.toBe(null);
    view.rerender(surface(client, { ...CONNECTED, writeAccess: 'denied' }, true));
    expect(dragGhost('v2')).toBe(null);
    view.rerender(surface(client, CONNECTED, false));
    pointer(document, 'pointerMove', 30);
    pointer(document, 'pointerMove', 40);
    expect(dragGhost('v2')).toBe(null);
    pointer(document, 'pointerUp', 40);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(layout().clips[X]).toMatchObject({ startFrame: 10, durationFrames: 14 });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    // A new drag after the cancelled one works: 20 px at 2 px per frame is 10 frames.
    fireEvent.click(screen.getByTestId('timeline-clip-' + X));
    pointer(grip(), 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 20);
    expect(dragGhost('v2')).not.toBe(null);
    pointer(document, 'pointerUp', 20);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    await waitFor(() => expect(layout().clips[X]).toMatchObject(kind === 'move' ? { startFrame: 20, durationFrames: 14 } : { startFrame: 10, durationFrames: 24 }));
  });

  it('names a peer removal when the dragged clip vanished before release', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 20);
    act(() => { write(doc, { operation: 'delete', parameters: { clipId: X }, placement: OFF }); });
    pointer(document, 'pointerUp', 20);
    await waitFor(() => expect(vi.mocked(toast.warning).mock.calls.map(([text]) => text)).toEqual(['This clip was removed by another member.']));
    expect(t('timeline.errors.clip_removed')).toBe('This clip was removed by another member.');
  });

  it('draws the ghost at the drop frame and the insertion marker at the gap the clip will fill (D2)', async () => {
    const A = '30000000-0000-4000-8000-000000000041';
    const B = '30000000-0000-4000-8000-000000000042';
    const C = '30000000-0000-4000-8000-000000000043';
    writeUserPreference(ME, { timelineSnap: false });
    seedLayout([clipAt(A, MAIN, 0, 10), clipAt(B, MAIN, 10, 10), clipAt(C, MAIN, 20, 10)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + A);
    fireEvent.click(clip);
    // Default zoom is 2 px per frame: 30 px is 15 frames, past B's midpoint, so the gap is B's end at 20 and A lands at 10.
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 30);
    const marker = await screen.findByTestId('timeline-insert-marker');
    expect(screen.getByTestId('timeline-track-' + MAIN)).toContainElement(marker);
    expect(marker.style.left).toBe('40px');
    expect((dragGhost(MAIN) as HTMLElement | null)?.style.left).toBe('30px');
    pointer(document, 'pointerUp', 30);
    await waitFor(() => expect(layout().clips[A]?.startFrame).toBe(10));
    expect(layout().clips[B]?.startFrame).toBe(0);
    expect(screen.queryByTestId('timeline-insert-marker')).toBe(null);
  });
});

describe('TimelineSpace zoom and ruler for long content (inner#1708 G4, R1)', () => {
  it('lets the zoom slider zoom out below the fixed minimum for long content', async () => {
    seedLayout([clipAt(X, 'v2', 1_000_000, 24)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    const thumb = within(screen.getByTestId('timeline-zoom')).getByRole('slider');
    expect(Number(thumb.getAttribute('aria-valuemin'))).toBeLessThan(0.25);
  });

  it('draws at most 400 ruler labels for a clip far along the Timeline', async () => {
    seedLayout([clipAt(X, 'v2', 200_000, 24)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    expect(screen.getByTestId('timeline-ruler').children.length).toBeLessThanOrEqual(400);
  });
});

describe('TimelineSpace round-four review fixes (inner#1708 F1c, F2, F3, F4, F5)', () => {
  const DAMAGED = '30000000-0000-4000-8000-0000000000dd';

  /**
   * End a pointer drag and wait out the 50 ms in which dnd-kit swallows clicks, which would reach the next case.
   * @param clientX - The release position.
   * @returns Once the click guard has lapsed.
   * @throws {Error} When a handler throws.
   */
  async function release(clientX: number): Promise<void> {
    pointer(document, 'pointerUp', clientX);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  }

  // A case that fails mid-drag leaves dnd-kit's document listeners active; end any drag before the next case.
  afterEach(async () => { await release(0); });

  /**
   * Write a clip record that misses most of its fields, as an interrupted collaborative write can leave it.
   * @param doc - The content document.
   * @throws {Error} When Yjs cannot attach the map.
   */
  function damageClip(doc: Y.Doc): void {
    doc.transact(() => {
      const record = new Y.Map<unknown>();
      doc.getMap('clips').set(DAMAGED, record);
      record.set('startFrame', 5);
    }, 'provider');
  }

  it('opens a Timeline holding a damaged clip record and lets an Editor delete the record (F1c)', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    damageClip(doc);
    showTimeline();
    expect(await screen.findByTestId('timeline-clip-' + X)).toBeInTheDocument();
    const row = screen.getByTestId('timeline-conflict-' + DAMAGED);
    expect(row).toHaveTextContent(t('timeline.conflictReason.damaged'));
    fireEvent.click(screen.getByTestId('timeline-damaged-delete-' + DAMAGED));
    await waitFor(() => expect(currentDoc().getMap('clips').has(DAMAGED)).toBe(false));
    expect(screen.queryByTestId('timeline-conflict-' + DAMAGED)).toBe(null);
    expect(layout().clips[X]).toMatchObject({ startFrame: 10, durationFrames: 14 });
  });

  it('shows a Viewer the damaged record without a delete button (F1c)', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    damageClip(doc);
    showTimeline({ ...CONNECTED, writeAccess: 'denied' }, true);
    expect(await screen.findByTestId('timeline-clip-' + X)).toBeInTheDocument();
    expect(screen.getByTestId('timeline-conflict-' + DAMAGED)).toHaveTextContent(t('timeline.conflictReason.damaged'));
    expect(screen.queryByTestId('timeline-damaged-delete-' + DAMAGED)).toBe(null);
  });

  it('names a removed track as the reason a clip conflicts (F2)', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 0, 14)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    act(() => { doc.transact(() => doc.getMap('tracks').delete('v2'), 'provider'); });
    await waitFor(() => expect(screen.getByTestId('timeline-reason-' + X)).toHaveTextContent(t('timeline.conflictReason.missing_track')));
  });

  it('names an overlap as the reason both merged clips conflict (F2)', async () => {
    const secondId = seedConflictingClips();
    const { view } = showTimeline();
    for (const id of [CLIP.id, secondId]) {
      expect(await screen.findByTestId('timeline-reason-' + id)).toHaveTextContent(t('timeline.conflictReason.overlap'));
    }
    // Specs count conflict rows by this prefix, so the reason must not match it.
    const rows = [...view.container.querySelectorAll('[data-testid^="timeline-conflict-"]')].map((element) => element.getAttribute('data-testid'));
    expect(rows.sort()).toEqual([`timeline-conflict-${CLIP.id}`, `timeline-conflict-${secondId}`].sort());
  });

  it('names a range outside the video as the reason a clip conflicts (F2)', async () => {
    seedLayout([clipAt(X, 'v2', 0, 14, { sourceInFrame: 40 })]);
    showTimeline();
    expect(await screen.findByTestId('timeline-reason-' + X)).toHaveTextContent(t('timeline.conflictReason.invalid_range'));
  });

  it('names an incompatible track as the reason a clip conflicts (F2)', async () => {
    seedLayout([clipAt(X, 'a1', 0, 14)], [track(MAIN, 0), track('v2', 1), { id: 'a1', kind: 'audio', order: 2 }]);
    showTimeline();
    expect(await screen.findByTestId('timeline-reason-' + X)).toHaveTextContent(t('timeline.conflictReason.incompatible_track'));
  });

  it('explains how to resolve conflicts including changing the track (F2, P2)', () => {
    expect(t('timeline.conflictHelp')).toBe('Conflicting clips don\'t play. Select one to fix it.');
  });

  it.each(['damaged', 'overlap', 'missing_track', 'invalid_range', 'incompatible_track', 'missing_source'])('has a %s reason in all five locales (F1c, F2, M3)', (code) => {
    for (const [tag, catalog] of LOCALE_CATALOGS) {
      const sentence = readPath(catalog, `timeline.conflictReason.${code}`);
      expect(typeof sentence, `${tag} timeline.conflictReason.${code}`).toBe('string');
      expect(String(sentence).trim()).not.toBe('');
    }
  });

  it('names sub tracks by the visual layer in every locale (F3)', async () => {
    const expected: Record<string, string> = { en: 'Visual {index}', 'zh-CN': '画面 {index}', 'zh-TW': '畫面 {index}', ja: '映像 {index}', ko: '영상 {index}' };
    for (const [tag, catalog] of LOCALE_CATALOGS) expect(readPath(catalog, 'timeline.track'), tag).toBe(expected[tag]);
    seedLayout([clipAt(X, 'v2', 0, 14)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    expect(within(screen.getByTestId('timeline-track-v2')).getByText('Visual 2')).toBeInTheDocument();
  });

  it('cancels a drag when the window loses focus (F4)', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    const before = Y.encodeStateAsUpdate(doc);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 40);
    expect(dragGhost('v2')).not.toBe(null);
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(dragGhost('v2')).toBe(null);
    pointer(document, 'pointerMove', 60);
    expect(dragGhost('v2')).toBe(null);
    await release(60);
    expect(layout().clips[X]?.startFrame).toBe(10);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('labels a sub-track move ghost with its frames and as an overwrite (F5)', async () => {
    writeUserPreference(ME, { timelineSnap: false });
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    // 40 px at 2 px per frame moves the start from 10 to 30.
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 40);
    const label = await screen.findByTestId('timeline-ghost-label');
    expect(label).toHaveTextContent(t('timeline.clipFrames', { start: 30, duration: 14 }));
    expect(label).toHaveTextContent(t('timeline.edit.ghostOverwrite'));
    expect(label).not.toHaveTextContent(t('timeline.edit.ghostInsert'));
    await release(40);
  });

  it.each([[true, 'ghostInsert', 'ghostOverwrite'], [false, 'ghostOverwrite', 'ghostInsert']] as const)(
    'labels a main-track move ghost with magnet %s as %s (F5)', async (on, shown, hidden) => {
      writeUserPreference(ME, { timelineSnap: false, timelineMagnet: on });
      const A = '30000000-0000-4000-8000-000000000061';
      seedLayout([clipAt(A, MAIN, 0, 10), clipAt(X, 'v2', 40, 8)]);
      showTimeline();
      const clip = await screen.findByTestId('timeline-clip-' + A);
      fireEvent.click(clip);
      pointer(clip, 'pointerDown', 0);
      pointer(document, 'pointerMove', 10);
      pointer(document, 'pointerMove', 30);
      const label = await screen.findByTestId('timeline-ghost-label');
      expect(label).toHaveTextContent(t('timeline.clipFrames', { start: 15, duration: 10 }));
      expect(label).toHaveTextContent(t(`timeline.edit.${shown}`));
      expect(label).not.toHaveTextContent(t(`timeline.edit.${hidden}`));
      await release(30);
    },
  );

  it('labels a trim ghost with its frames only (F5)', async () => {
    writeUserPreference(ME, { timelineSnap: false });
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const handle = screen.getByTestId('timeline-trim-end-' + X);
    // 20 px at 2 px per frame lengthens the clip from 14 to 24 frames.
    pointer(handle, 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 20);
    const label = await screen.findByTestId('timeline-ghost-label');
    expect(label).toHaveTextContent(t('timeline.clipFrames', { start: 10, duration: 24 }));
    expect(label).not.toHaveTextContent(t('timeline.edit.ghostInsert'));
    expect(label).not.toHaveTextContent(t('timeline.edit.ghostOverwrite'));
    await release(20);
  });
});

describe('TimelineSpace heals dangling sources only for an Editor (inner#1708 H1, H2)', () => {
  /**
   * Remove the stored source under the existing clip through a remote update, as a merged peer sweep can.
   * @throws {Error} When the update cannot be applied.
   */
  function dropSourceRemotely(): void {
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(currentDoc()));
      peer.transact(() => peer.getMap('sources').delete(SOURCE.id), 'peer');
      act(() => { Y.applyUpdate(currentDoc(), Y.encodeStateAsUpdate(peer, Y.encodeStateVector(currentDoc())), 'provider'); });
    } finally { peer.destroy(); }
  }

  it('writes the source back for an Editor', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    dropSourceRemotely();
    await waitFor(() => expect(currentDoc().getMap('sources').get(SOURCE.id)).toEqual(SOURCE));
    expect(screen.getByTestId('timeline-undo')).toBeDisabled();
  });

  it('leaves the source missing for a Viewer and writes nothing', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline({ ...CONNECTED, writeAccess: 'denied' }, true);
    await screen.findByTestId('timeline-clip-' + X);
    let ownUpdates = 0;
    currentDoc().on('update', (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => { if (transaction.local) ownUpdates += 1; });
    dropSourceRemotely();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(currentDoc().getMap('sources').has(SOURCE.id)).toBe(false);
    expect(ownUpdates).toBe(0);
  });
});

describe('TimelineSpace clips whose source is missing (inner#1708 M2, M3)', () => {
  const MISSING_SOURCE = '10000000-0000-4000-8000-0000000000ff';

  it('says the missing video in every locale', () => {
    const expected: Record<string, string> = {
      en: 'Its video is missing', 'zh-CN': '所用视频已丢失', 'zh-TW': '所用影片已遺失', ja: '動画が見つかりません', ko: '동영상을 찾을 수 없습니다',
    };
    for (const [tag, catalog] of LOCALE_CATALOGS) expect(readPath(catalog, 'timeline.conflictReason.missing_source'), tag).toBe(expected[tag]);
  });

  it('lists the clip as a conflict naming the missing video, and an Editor can select and delete it', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 10, 14, { sourceId: MISSING_SOURCE })]);
    showTimeline();
    const row = await screen.findByTestId('timeline-conflict-' + X);
    expect(screen.getByTestId('timeline-reason-' + X)).toHaveTextContent(t('timeline.conflictReason.missing_source'));
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('timeline-delete'));
    await waitFor(() => expect(layout().clips[X]).toBe(undefined));
    expect(screen.queryByTestId('timeline-conflict-' + X)).toBe(null);
  });

  it('previews the clip below over its frames instead of failing', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 10, 14, { sourceId: MISSING_SOURCE })]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + CLIP.id);
    const seek = screen.getByRole('slider', { name: t('timeline.seek') });
    seek.focus();
    for (let step = 0; step < 15; step += 1) fireEvent.keyDown(seek, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByText(position(15, 48))).toBeInTheDocument());
    // breatic#1410 §6.1: each video element carries its clip id; the clip without a video draws none.
    await waitFor(() => previewVideo(CLIP.id));
    expect(screen.getByTestId('timeline-preview').querySelector(`video[data-clip-id="${X}"]`)).toBe(null);
    expect(screen.getByTestId('timeline-preview').hasAttribute('data-active-clip-id')).toBe(false);
    expect(screen.queryByText(t('timeline.mediaUnavailable'))).toBe(null);
  });
});

describe('TimelineSpace refuses moving a clip whose video is missing (inner#1708 P2)', () => {
  const MISSING_SOURCE = '10000000-0000-4000-8000-0000000000ff';

  it('says what to do in every locale', () => {
    const errors: Record<string, string> = {
      en: 'This clip\'s video is missing. Delete the clip first.',
      'zh-CN': '片段所用视频已丢失，请先删除该片段。',
      'zh-TW': '片段所用影片已遺失，請先刪除該片段。',
      ja: 'クリップの動画が見つかりません。先にクリップを削除してください。',
      ko: '클립의 동영상을 찾을 수 없습니다. 먼저 클립을 삭제하세요.',
    };
    const help: Record<string, string> = {
      en: 'Conflicting clips don\'t play. Select one to fix it.',
      'zh-CN': '冲突的片段不会播放，选择片段进行修改。',
      'zh-TW': '衝突的片段不會播放，選取片段進行修改。',
      ja: '競合しているクリップは再生されません。クリップを選択して修正してください。',
      ko: '충돌한 클립은 재생되지 않습니다. 클립을 선택해 수정하세요.',
    };
    for (const [tag, catalog] of LOCALE_CATALOGS) {
      expect(readPath(catalog, 'timeline.errors.missing_source'), tag).toBe(errors[tag]);
      expect(readPath(catalog, 'timeline.conflictHelp'), tag).toBe(help[tag]);
    }
  });

  it('warns with the missing-video message when a nudge would move it', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14, { sourceId: MISSING_SOURCE })]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    const before = Y.encodeStateAsUpdate(doc);
    press(clip, 'ArrowRight');
    await waitFor(() => expect(vi.mocked(toast.warning).mock.calls.map(([message]) => message)).toContain('This clip\'s video is missing. Delete the clip first.'));
    expect(t('timeline.errors.missing_source')).toBe('This clip\'s video is missing. Delete the clip first.');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('warns with the missing-video message when a drag would move it', async () => {
    writeUserPreference(ME, { timelineSnap: false });
    const doc = seedLayout([clipAt(X, 'v2', 10, 14, { sourceId: MISSING_SOURCE })]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    const before = Y.encodeStateAsUpdate(doc);
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 40);
    pointer(document, 'pointerUp', 40);
    await waitFor(() => expect(vi.mocked(toast.warning).mock.calls.map(([message]) => message)).toContain('This clip\'s video is missing. Delete the clip first.'));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  });
});

describe('TimelineSpace round-nine review fixes (inner#1708 R1, R2, R3, R4)', () => {
  const MISSING_SOURCE = '10000000-0000-4000-8000-0000000000ff';
  const COVERS = 'A clip in the way has lost its video. Delete that clip first.';

  /**
   * The warning toasts shown so far.
   * @returns Their messages.
   * @throws {never} Never.
   */
  function warnings(): unknown[] {
    return vi.mocked(toast.warning).mock.calls.map(([message]) => message);
  }

  it('says a clip in the way lost its video in every locale (R3)', () => {
    const expected: Record<string, string> = {
      en: COVERS,
      'zh-CN': '此处有片段的视频已丢失，请先删除那个片段。',
      'zh-TW': '此處有片段的影片已遺失，請先刪除那個片段。',
      ja: 'この位置にあるクリップの動画が見つかりません。先にそのクリップを削除してください。',
      ko: '이 위치에 있는 클립의 동영상을 찾을 수 없습니다. 먼저 그 클립을 삭제하세요.',
    };
    for (const [tag, catalog] of LOCALE_CATALOGS) expect(readPath(catalog, 'timeline.errors.covers_missing_source'), tag).toBe(expected[tag]);
  });

  it('passes an in-point typed for a clip without its video to the planner, which refuses it with the missing-video toast (R1)', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14, { sourceInFrame: 4, sourceId: MISSING_SOURCE })]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const before = Y.encodeStateAsUpdate(doc);
    commitField('timeline-clip-in', '2');
    await waitFor(() => expect(warnings()).toContain(t('timeline.errors.missing_source')));
    expect(screen.queryByTestId('timeline-clip-field-error')).toBe(null);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('warns that a clip in the way lost its video when a drag would trim its head (R2)', async () => {
    writeUserPreference(ME, { timelineSnap: false });
    const A = '30000000-0000-4000-8000-000000000071';
    const doc = seedLayout([clipAt(X, 'v2', 10, 14, { sourceId: MISSING_SOURCE }), clipAt(A, 'v2', 60, 10)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + A);
    fireEvent.click(clip);
    const before = Y.encodeStateAsUpdate(doc);
    // -110 px at 2 px per frame moves A from 60 to 5, over X's head at 10.
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', -10);
    pointer(document, 'pointerMove', -110);
    pointer(document, 'pointerUp', -110);
    await waitFor(() => expect(warnings()).toContain(COVERS));
    expect(t('timeline.errors.covers_missing_source')).toBe(COVERS);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  });

  it('shows the add dialog error when the new clip would trim the head of a clip without its video (R2)', async () => {
    seedLayout([clipAt(X, 'v2', 20, 100, { sourceId: MISSING_SOURCE })]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const dialog = await openMaterial();
    expect(within(dialog).getByTestId('timeline-material-track')).toHaveTextContent(t('timeline.track', { index: 2 }));
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(within(dialog).getByTestId('timeline-material-error')).toHaveTextContent(COVERS));
    expect(Object.keys(layout().clips)).toEqual([X]);
  });

  it.each(['', '1e3', '5.0'])('hides the main-track insert hint for the start %j (R4)', async (text) => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + CLIP.id);
    const dialog = await openMaterial();
    await waitFor(() => expect(within(dialog).getByTestId('timeline-material-insert-hint')).toBeInTheDocument());
    fireEvent.change(within(dialog).getByTestId('timeline-start-frame'), { target: { value: text } });
    expect(within(dialog).queryByTestId('timeline-material-insert-hint')).toBe(null);
  });

  it.each(['', '1e3', '5.0'])('refuses the start %j on confirm, as the hint does (R4)', async (text) => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + CLIP.id);
    const dialog = await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    fireEvent.change(within(dialog).getByTestId('timeline-start-frame'), { target: { value: text } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(within(dialog).getByTestId('timeline-material-error')).toHaveTextContent(t('timeline.errors.invalid_range')));
    expect(Object.keys(layout().clips)).toEqual([CLIP.id]);
  });
});

describe('TimelineSpace round-ten review fixes (inner#1708 S1, S2, S3, Q1)', () => {
  const MISSING_SOURCE = '10000000-0000-4000-8000-0000000000ff';

  /**
   * The warning toasts shown so far.
   * @returns Their messages.
   * @throws {never} Never.
   */
  function warnings(): unknown[] {
    return vi.mocked(toast.warning).mock.calls.map(([message]) => message);
  }

  it('warns with the missing-video message when trimming a clip without its video (S1)', async () => {
    writeUserPreference(ME, { timelineSnap: false });
    const doc = seedLayout([clipAt(X, 'v2', 10, 20, { sourceInFrame: 5, sourceId: MISSING_SOURCE })]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const handle = screen.getByTestId('timeline-trim-end-' + X);
    const before = Y.encodeStateAsUpdate(doc);
    // 6 px at 2 px per frame lengthens the clip by three frames.
    pointer(handle, 'pointerDown', 0);
    pointer(document, 'pointerMove', 4);
    pointer(document, 'pointerMove', 6);
    pointer(document, 'pointerUp', 6);
    await waitFor(() => expect(warnings()).toContain(t('timeline.errors.missing_source')));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  });

  it.each([['Alt+ArrowDown', 'ArrowDown'], ['Alt+ArrowUp', 'ArrowUp']] as const)('warns that the track is missing on %s for a clip on a removed track (S2)', async (_name, key) => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    act(() => { doc.transact(() => doc.getMap('tracks').delete('v2'), 'provider'); });
    const row = await screen.findByTestId('timeline-conflict-' + X);
    fireEvent.click(row);
    const before = Y.encodeStateAsUpdate(doc);
    press(row, key, { altKey: true });
    await waitFor(() => expect(warnings()).toContain(t('timeline.errors.track_missing')));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(layout().clips[X]).toMatchObject({ trackId: 'v2', startFrame: 10 });
  });

  it('keeps a held arrow key from joining an unrelated earlier edit (S3)', async () => {
    const OTHER = '30000000-0000-4000-8000-000000000081';
    seedLayout([clipAt(X, 'v2', 0, 20), clipAt(OTHER, 'v2', 100, 20)]);
    showTimeline();
    const other = await screen.findByTestId('timeline-clip-' + OTHER);
    fireEvent.click(other);
    press(other, 'Delete');
    await waitFor(() => expect(layout().clips[OTHER]).toBe(undefined));
    const clip = screen.getByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    // The key was already held before this clip was selected, so every press arrives as a repeat.
    press(clip, 'ArrowRight', { repeat: true });
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(1));
    press(screen.getByTestId('timeline-clip-' + X), 'ArrowRight', { repeat: true });
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(2));
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(0));
    expect(layout().clips[OTHER]).toBe(undefined);
    expect(screen.getByTestId('timeline-undo')).toBeEnabled();
  });

  it('orders the main-track clip buttons by time after an insert at frame 0 (Q1)', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + CLIP.id);
    await openMaterial();
    fireEvent.click(await screen.findByTestId('timeline-project-video-' + ASSET.assetId));
    fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(layout().clips)).toHaveLength(2));
    const added = Object.values(layout().clips).find((item) => item.id !== CLIP.id);
    expect(added?.startFrame).toBe(0);
    await waitFor(() => {
      const order = [...screen.getByTestId('timeline-track-' + MAIN).querySelectorAll('[data-testid^="timeline-clip-"][data-track-id]')]
        .map((element) => element.getAttribute('data-testid'));
      expect(order).toEqual([`timeline-clip-${added?.id ?? ''}`, `timeline-clip-${CLIP.id}`]);
    });
  });
});

describe('TimelineSpace ends a key hold on every new press and selection change (inner#1708 T1)', () => {
  const A = '30000000-0000-4000-8000-000000000091';
  const B = '30000000-0000-4000-8000-000000000092';

  /**
   * Two sub-track clips with the magnet off; the first is moved two frames by one held ArrowRight.
   * @returns Once A has moved to frame 2.
   * @throws {Error} When a step fails.
   */
  async function holdOnA(): Promise<void> {
    magnet(false);
    seedLayout([clipAt(A, 'v2', 0, 10), clipAt(B, 'v2', 100, 10)]);
    showTimeline();
    const a = await screen.findByTestId('timeline-clip-' + A);
    fireEvent.click(a);
    press(a, 'ArrowRight');
    press(a, 'ArrowRight', { repeat: true });
    await waitFor(() => expect(layout().clips[A]?.startFrame).toBe(2));
  }

  it('keeps a hold begun on another clip mid-scrub out of the earlier hold step', async () => {
    await holdOnA();
    fireEvent.pointerDown(screen.getByTestId('timeline-lane-v2'));
    await waitFor(() => expect(screen.getByTestId('timeline-clip-' + A)).toHaveAttribute('aria-pressed', 'false'));
    press(screen.getByTestId('timeline-space'), 'ArrowRight');
    press(screen.getByTestId('timeline-space'), 'ArrowRight', { repeat: true });
    const b = screen.getByTestId('timeline-clip-' + B);
    fireEvent.click(b);
    press(b, 'ArrowRight', { repeat: true });
    press(b, 'ArrowRight', { repeat: true });
    await waitFor(() => expect(layout().clips[B]?.startFrame).toBe(102));
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[B]?.startFrame).toBe(100));
    expect(layout().clips[A]?.startFrame).toBe(2);
    expect(screen.getByTestId('timeline-undo')).toBeEnabled();
  });

  it('keeps a hold that continues after a new key press out of the earlier hold step', async () => {
    await holdOnA();
    const b = screen.getByTestId('timeline-clip-' + B);
    act(() => b.focus());
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));
    press(b, 'ArrowRight', { altKey: true });
    press(b, 'ArrowRight', { altKey: true, repeat: true });
    press(b, 'ArrowRight', { repeat: true });
    await waitFor(() => expect(layout().clips[B]?.startFrame).toBe(101));
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[B]?.startFrame).toBe(100));
    expect(layout().clips[A]?.startFrame).toBe(2);
    expect(screen.getByTestId('timeline-undo')).toBeEnabled();
  });
});

describe('TimelineSpace ignores edit shortcuts during a drag (inner#1708 R1)', () => {
  /**
   * End a drag and wait out dnd-kit's click guard.
   * @param clientX - The release position.
   * @returns Once the guard lapsed.
   * @throws {Error} When a handler throws.
   */
  async function drop(clientX: number): Promise<void> {
    pointer(document, 'pointerUp', clientX);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  }

  /** What the user did before the drag, so each shortcut has something it would change. */
  type Before = 'nothing' | 'nudge' | 'nudge-undo' | 'playhead';

  /**
   * Select X[10,24) on v2, optionally prepare the history or playhead, and drag X 20 px (10 frames) right,
   * past the activation distance.
   * @param before - What happens before the drag: a nudge (undo has a step), a nudge then Undo (redo has one),
   * or the playhead moved to frame 15 inside X (split applies).
   * @returns The document, the clip button and X's start before the drag.
   * @throws {Error} When the clip is absent.
   */
  async function dragging(before: Before = 'nothing'): Promise<{ doc: Y.Doc; clip: HTMLElement; start: number }> {
    writeUserPreference(ME, { timelineSnap: false });
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    let clip = await screen.findByTestId('timeline-clip-' + X);
    if (before === 'playhead') {
      for (let step = 0; step < 15; step += 1) press(screen.getByTestId('timeline-space'), 'ArrowRight');
      await waitFor(() => expect(screen.getByText(position(15, 24))).toBeInTheDocument());
    }
    fireEvent.click(clip);
    if (before === 'nudge' || before === 'nudge-undo') {
      press(clip, 'ArrowRight');
      await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(11));
    }
    if (before === 'nudge-undo') {
      fireEvent.click(screen.getByTestId('timeline-undo'));
      await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(10));
      clip = screen.getByTestId('timeline-clip-' + X);
      fireEvent.click(clip);
    }
    const start = layout().clips[X]?.startFrame ?? 0;
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 20);
    expect(dragGhost('v2')).not.toBe(null);
    return { doc, clip, start };
  }

  afterEach(async () => { await drop(0); });

  it('keeps the dragged clip on Delete and commits the drag on release', async () => {
    const { clip } = await dragging();
    vi.mocked(toast.warning).mockClear();
    act(() => { fireEvent.keyDown(clip, { key: 'Delete' }); });
    expect(layout().clips[X]).toBeDefined();
    await drop(20);
    expect(layout().clips[X]?.startFrame).toBe(20);
    expect(vi.mocked(toast.warning).mock.calls.map(([text]) => text)).not.toContain(t('timeline.errors.clip_removed'));
  });

  it('does not undo during the drag; the drag is one undo step after release', async () => {
    writeUserPreference(ME, { timelineSnap: false });
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    press(clip, 'ArrowRight');
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(11));
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 20);
    act(() => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'z', metaKey: true }); });
    expect(layout().clips[X]?.startFrame).toBe(11);
    await drop(20);
    expect(layout().clips[X]?.startFrame).toBe(21);
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(11));
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[X]?.startFrame).toBe(10));
  });

  it.each([
    ['Backspace', { key: 'Backspace' }, 'nothing'],
    ['Ctrl+Z', { key: 'z', ctrlKey: true }, 'nudge'],
    ['Cmd+Shift+Z', { key: 'z', metaKey: true, shiftKey: true }, 'nudge-undo'],
    ['Ctrl+Y', { key: 'y', ctrlKey: true }, 'nudge-undo'],
    ['Cmd+D', { key: 'd', metaKey: true }, 'nothing'],
    ['Ctrl+D', { key: 'd', ctrlKey: true }, 'nothing'],
    ['Cmd+B', { key: 'b', metaKey: true }, 'playhead'],
    ['Ctrl+B', { key: 'b', ctrlKey: true }, 'playhead'],
    ['ArrowLeft', { key: 'ArrowLeft' }, 'nothing'],
    ['ArrowRight', { key: 'ArrowRight' }, 'nothing'],
    ['Alt+ArrowUp', { key: 'ArrowUp', altKey: true }, 'nothing'],
    ['Alt+ArrowDown', { key: 'ArrowDown', altKey: true }, 'nothing'],
  ] as const)('writes nothing for %s during the drag', async (_name, event, before) => {
    const { doc, clip, start } = await dragging(before);
    const bytes = Y.encodeStateAsUpdate(doc);
    act(() => { fireEvent.keyDown(clip, event); });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    await drop(20);
    expect(layout().clips[X]).toMatchObject({ trackId: 'v2', startFrame: start + 10 });
    expect(Object.keys(layout().clips)).toEqual([X]);
  });

  it('still toggles snapping with N during the drag', async () => {
    const { clip } = await dragging();
    const toggle = screen.getByTestId('timeline-toggle-snap');
    const before = toggle.getAttribute('aria-pressed');
    act(() => { fireEvent.keyDown(clip, { key: 'n' }); });
    expect(toggle.getAttribute('aria-pressed')).not.toBe(before);
  });

  it('still deletes on Delete while the press has not moved past the drag threshold', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', 1);
    act(() => { fireEvent.keyDown(clip, { key: 'Delete' }); });
    await waitFor(() => expect(layout().clips[X]).toBe(undefined));
  });
});

describe('TimelineSpace keeps keyboard focus on the moved clip (inner#1708 G1)', () => {
  /**
   * The clip button with this id.
   * @param id - The clip.
   * @returns Its button.
   * @throws {Error} When it is absent.
   */
  function clipButton(id: string): HTMLElement {
    return screen.getByTestId('timeline-clip-' + id);
  }

  /**
   * Focus a clip and press a key on whatever then holds focus.
   * @param key - The key.
   * @param modifiers - Modifier flags.
   * @throws {Error} When a handler throws.
   */
  function pressFocused(key: string, modifiers: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>> = {}): void {
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...modifiers });
  }

  it('returns focus to a clip Alt+Up moved to the track above and to a new top track (a)', async () => {
    seedLayout([clipAt(X, MAIN, 0, 24)]);
    showTimeline();
    act(() => clipButton(X).focus());
    pressFocused('ArrowUp', { altKey: true });
    await waitFor(() => expect(layout().clips[X]?.trackId).toBe('v2'));
    await waitFor(() => expect(document.activeElement).toBe(clipButton(X)));
    pressFocused('ArrowUp', { altKey: true });
    await waitFor(() => expect(Object.keys(layout().tracks)).toHaveLength(3));
    await waitFor(() => expect(document.activeElement).toBe(clipButton(X)));
  });

  it('returns focus to a clip that undo and redo move to another track (b)', async () => {
    seedLayout([clipAt(X, MAIN, 0, 24)]);
    showTimeline();
    act(() => clipButton(X).focus());
    pressFocused('ArrowUp', { altKey: true });
    await waitFor(() => expect(layout().clips[X]?.trackId).toBe('v2'));
    await waitFor(() => expect(document.activeElement).toBe(clipButton(X)));
    pressFocused('z', { metaKey: true });
    await waitFor(() => expect(layout().clips[X]?.trackId).toBe(MAIN));
    await waitFor(() => expect(document.activeElement).toBe(clipButton(X)));
    pressFocused('z', { metaKey: true, shiftKey: true });
    await waitFor(() => expect(layout().clips[X]?.trackId).toBe('v2'));
    await waitFor(() => expect(document.activeElement).toBe(clipButton(X)));
  });

  it('returns focus to a clip a peer moves to another track (c)', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    act(() => clipButton(X).focus());
    act(() => { write(doc, { operation: 'move', parameters: { clipId: X, startFrame: 10, trackId: MAIN }, placement: OFF }); });
    await waitFor(() => expect(clipButton(X)).toHaveAttribute('data-track-id', MAIN));
    await waitFor(() => expect(document.activeElement).toBe(clipButton(X)));
  });

  it('moves focus to the Timeline root when the focused clip is deleted, and undo works from there (d)', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    act(() => clipButton(X).focus());
    pressFocused('Delete');
    await waitFor(() => expect(layout().clips[X]).toBe(undefined));
    const root = screen.getByTestId('timeline-space');
    await waitFor(() => expect(document.activeElement).toBe(root));
    expect(root).toHaveAttribute('tabindex', '-1');
    pressFocused('z', { metaKey: true });
    await waitFor(() => expect(layout().clips[X]).toMatchObject({ trackId: 'v2', startFrame: 10 }));
  });

  it('leaves focus in a properties field when the selected clip moves (e)', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const field = screen.getByTestId('timeline-clip-duration');
    act(() => field.focus());
    act(() => { write(doc, { operation: 'move', parameters: { clipId: X, startFrame: 10, trackId: MAIN }, placement: OFF }); });
    await waitFor(() => expect(clipButton(X)).toHaveAttribute('data-track-id', MAIN));
    expect(document.activeElement?.getAttribute('data-testid')).toBe('timeline-clip-duration');
  });

  it('leaves focus outside the Timeline when a clip is deleted (e)', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    expect(document.activeElement).toBe(document.body);
    act(() => { write(doc, { operation: 'delete', parameters: { clipId: X }, placement: OFF }); });
    await waitFor(() => expect(layout().clips[X]).toBe(undefined));
    expect(document.activeElement).toBe(document.body);
  });
});

describe('TimelineSpace lists a clip record stored under another key as damaged (inner#1708 Q1)', () => {
  it('shows it with a delete control that removes the record', async () => {
    const KEY = '30000000-0000-4000-8000-0000000000e1';
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    doc.transact(() => {
      const record = new Y.Map<unknown>();
      doc.getMap('clips').set(KEY, record);
      for (const [name, value] of Object.entries(clipAt(Y2, 'v2', 60, 10))) record.set(name, value);
    }, 'provider');
    showTimeline();
    const row = await screen.findByTestId('timeline-conflict-' + KEY);
    expect(row).toHaveTextContent(t('timeline.conflictReason.damaged'));
    expect(screen.queryByTestId('timeline-clip-' + Y2)).toBe(null);
    fireEvent.click(screen.getByTestId('timeline-damaged-delete-' + KEY));
    await waitFor(() => expect(currentDoc().getMap('clips').has(KEY)).toBe(false));
    expect(layout().clips[X]).toMatchObject({ startFrame: 10 });
  });
});

describe('TimelineSpace hands focus to its root when a focused control leaves the page (inner#1708 F1)', () => {
  const MISFILED = '30000000-0000-4000-8000-0000000000f1';

  /**
   * Store a damaged clip record a peer wrote.
   * @param doc - The content document.
   * @throws {Error} When Yjs cannot attach the map.
   */
  function damaged(doc: Y.Doc): void {
    doc.transact(() => {
      const record = new Y.Map<unknown>();
      doc.getMap('clips').set(MISFILED, record);
      record.set('startFrame', 5);
    }, 'provider');
  }

  /**
   * The Timeline root.
   * @returns Its element.
   * @throws {Error} When it is absent.
   */
  function root(): HTMLElement {
    return screen.getByTestId('timeline-space');
  }

  it('moves focus to the root when a track delete button activated by keyboard removes its track (a)', async () => {
    const user = userEvent.setup();
    seedLayout([clipAt(X, MAIN, 0, 24)]);
    showTimeline();
    const remove = await screen.findByTestId('timeline-delete-track-v2');
    act(() => remove.focus());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(layout().tracks.v2).toBe(undefined));
    await waitFor(() => expect(document.activeElement).toBe(root()));
  });

  it('moves focus to the root when Delete on a focused conflict row removes its clip (b)', async () => {
    const user = userEvent.setup();
    const doc = seedLayout([clipAt(X, 'v2', 0, 14)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    act(() => { doc.transact(() => doc.getMap('tracks').delete('v2'), 'provider'); });
    const row = await screen.findByTestId('timeline-conflict-' + X);
    await user.click(row);
    expect(document.activeElement).toBe(row);
    await user.keyboard('{Delete}');
    await waitFor(() => expect(layout().clips[X]).toBe(undefined));
    expect(screen.queryByTestId('timeline-conflict-' + X)).toBe(null);
    await waitFor(() => expect(document.activeElement).toBe(root()));
  });

  it('moves focus to the root when the delete control of a damaged row activated by keyboard removes the row (c)', async () => {
    const user = userEvent.setup();
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    damaged(doc);
    showTimeline();
    const remove = await screen.findByTestId('timeline-damaged-delete-' + MISFILED);
    act(() => remove.focus());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(currentDoc().getMap('clips').has(MISFILED)).toBe(false));
    expect(screen.queryByTestId('timeline-conflict-' + MISFILED)).toBe(null);
    await waitFor(() => expect(document.activeElement).toBe(root()));
  });

  it('leaves focus on a control outside the Timeline when the Timeline control focused before is removed', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    damaged(doc);
    showTimeline();
    const remove = await screen.findByTestId('timeline-damaged-delete-' + MISFILED);
    act(() => remove.focus());
    const outside = document.createElement('button');
    document.body.append(outside);
    try {
      act(() => outside.focus());
      act(() => { doc.transact(() => doc.getMap('clips').delete(MISFILED), 'provider'); });
      await waitFor(() => expect(screen.queryByTestId('timeline-conflict-' + MISFILED)).toBe(null));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.activeElement).toBe(outside);
    } finally { outside.remove(); }
  });
});

describe('TimelineSpace side panel, conflicts and clip lengths (inner#1708 visual V14-V17, V19, V21)', () => {
  it('lists name, reason and frames in a conflict row without the conflict word, which stays on the clip and in properties (V14)', async () => {
    seedConflictingClips();
    showTimeline();
    const row = await screen.findByTestId('timeline-conflict-' + CLIP.id);
    await waitFor(() => expect(row).toHaveTextContent('Product launch.mp4'));
    expect(row).toHaveTextContent(t('timeline.conflictReason.overlap'));
    expect(row).toHaveTextContent(t('timeline.clipFrames', { start: 0, duration: 48 }));
    expect(within(row).queryByText(t('timeline.conflict'), { exact: true })).toBe(null);
    expect(within(screen.getByTestId('timeline-clip-' + CLIP.id)).getByText(t('timeline.conflict'), { exact: true })).toBeInTheDocument();
    fireEvent.click(row);
    expect(within(properties()).getByText(t('timeline.conflict'), { exact: true })).toBeInTheDocument();
  });

  it.each([['an Editor', false], ['a Viewer', true]] as const)('always shows the conflicts section to %s, with an empty state when nothing conflicts (V15)', async (_role, readOnly) => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline(readOnly ? { ...CONNECTED, writeAccess: 'denied' } : CONNECTED, readOnly);
    await screen.findByTestId('timeline-clip-' + X);
    const section = screen.getByTestId('timeline-conflicts');
    expect(within(section).getByText(t('timeline.conflictList'))).toBeInTheDocument();
    expect(within(section).getByText(t('timeline.noConflicts'))).toBeInTheDocument();
    expect(within(section).queryByText(t('timeline.conflictHelp'))).toBe(null);
  });

  it.each([['an Editor', false], ['a Viewer', true]] as const)('shows %s the help and the rows instead of the empty state once a clip conflicts (V15)', async (_role, readOnly) => {
    seedConflictingClips();
    showTimeline(readOnly ? { ...CONNECTED, writeAccess: 'denied' } : CONNECTED, readOnly);
    await screen.findByTestId('timeline-conflict-' + CLIP.id);
    const section = screen.getByTestId('timeline-conflicts');
    expect(within(section).getByText(t('timeline.conflictList'))).toBeInTheDocument();
    expect(within(section).getByText(t('timeline.conflictHelp'))).toBeInTheDocument();
    expect(within(section).getByTestId('timeline-conflict-' + CLIP.id)).toBeInTheDocument();
    expect(within(section).queryByText(t('timeline.noConflicts'))).toBe(null);
  });

  it('holds the conflicts and the properties in one side panel, apart from the preview and the tracks (V16)', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    const panel = screen.getByTestId('timeline-side-panel');
    expect(within(panel).getByTestId('timeline-conflicts')).toBeInTheDocument();
    expect(within(panel).getByText(t('timeline.selectClip'))).toBeInTheDocument();
    expect(within(panel).queryByTestId('timeline-preview')).toBe(null);
    expect(within(panel).queryByTestId('timeline-lane-v2')).toBe(null);
    expect(within(panel).queryByTestId('timeline-clip-' + X)).toBe(null);
    fireEvent.click(screen.getByTestId('timeline-clip-' + X));
    expect(within(panel).getByTestId('timeline-clip-start')).toBeInTheDocument();
    expect(within(panel).getByTestId('timeline-clip-duration')).toBeInTheDocument();
  });

  it.each([
    ['scrolls a start outside the visible lanes into view', 500, true],
    ['leaves the scroll alone for a start already visible', 50, false],
  ] as const)('selects the clip, seeks to its start and %s when its conflict row is pressed (V17)', async (_name, startFrame, scrolls) => {
    const ready = clipAt(Y2, MAIN, 0, 14);
    const doc = seedLayout([ready, clipAt(X, 'v2', startFrame, 14)]);
    showTimeline();
    const clipButton = await screen.findByTestId('timeline-clip-' + X);
    const pixelsPerFrame = parseFloat((clipButton.parentElement as HTMLElement).style.left) / startFrame;
    act(() => { doc.transact(() => doc.getMap('tracks').delete('v2'), 'provider'); });
    const row = await screen.findByTestId('timeline-conflict-' + X);
    const viewport = screen.getByTestId('timeline-ruler').closest('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) throw new Error('No track area viewport');
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    viewport.scrollLeft = 0;
    const scrollTo = vi.fn();
    viewport.scrollTo = scrollTo as unknown as typeof viewport.scrollTo;
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByText(position(startFrame, startFrame + 14))).toBeInTheDocument());
    if (scrolls) await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: Math.max(0, startFrame * pixelsPerFrame - 24) })));
    else expect(scrollTo).not.toHaveBeenCalled();
  });

  it('keeps only the delete action on a damaged row (V17)', async () => {
    const damagedId = '30000000-0000-4000-8000-0000000000d7';
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    doc.transact(() => {
      const record = new Y.Map<unknown>();
      doc.getMap('clips').set(damagedId, record);
      record.set('startFrame', 5);
    }, 'provider');
    showTimeline();
    const row = await screen.findByTestId('timeline-conflict-' + damagedId);
    expect(within(row).getAllByRole('button').map((button) => button.getAttribute('data-testid'))).toEqual(['timeline-damaged-delete-' + damagedId]);
  });

  it('shows each clip\'s length under its name and follows a trim (V19)', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14), clipAt(Y2, MAIN, 0, 1)]);
    showTimeline();
    expect(await screen.findByTestId('timeline-clip-' + X)).toHaveTextContent(timecode(14));
    expect(screen.getByTestId('timeline-clip-' + Y2)).toHaveTextContent(timecode(1));
    act(() => { write(doc, { operation: 'set_range', parameters: { clipId: X, startFrame: 10, sourceInFrame: 0, durationFrames: 20 }, placement: OFF }); });
    await waitFor(() => expect(screen.getByTestId('timeline-clip-' + X)).toHaveTextContent(timecode(20)));
  });

  it('shows the Delete shortcut on the Delete button, as Split and Duplicate show theirs (V21)', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    for (const [testId, shortcut] of [
      ['timeline-split', formatShortcut({ mod: true, key: 'B' })],
      ['timeline-duplicate', formatShortcut({ mod: true, key: 'D' })],
      ['timeline-delete', formatShortcut({ key: 'Delete' })],
    ] as const) {
      const button = screen.getByTestId(testId);
      expect(button.querySelector('kbd')?.textContent, testId).toBe(shortcut);
    }
  });
});

describe('TimelineSpace previews a drop into the new-track zone (inner#1708 visual V13)', () => {
  // dnd-kit picks the hovered row from measured rectangles; jsdom measures nothing, so rows get fixed boxes.
  const BOXES: Record<string, [number, number]> = { 'timeline-new-track-zone': [0, 30], 'timeline-track-v2': [100, 150], 'timeline-track-visual-1': [200, 260] };

  afterEach(async () => {
    pointer(document, 'pointerUp', 0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  });

  it('draws the ghost with its frames and the zone hint in the zone and nowhere else', async () => {
    writeUserPreference(ME, { timelineSnap: false });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element): DOMRect {
      const id = this.getAttribute('data-testid') ?? '';
      const box = BOXES[id] ?? (id === 'timeline-clip-' + X ? [5, 25] as [number, number] : undefined);
      if (box === undefined) return new DOMRect(0, 0, 0, 0);
      return id.startsWith('timeline-clip-') ? new DOMRect(20, box[0], 28, box[1] - box[0]) : new DOMRect(0, box[0], 2000, box[1] - box[0]);
    });
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + X);
    fireEvent.click(clip);
    pointer(clip, 'pointerDown', 0);
    pointer(document, 'pointerMove', 10);
    pointer(document, 'pointerMove', 20);
    const zone = screen.getByTestId('timeline-new-track-zone');
    await waitFor(() => expect(zone).toHaveTextContent(t('timeline.edit.newTrackZone')));
    const label = within(zone).getByTestId('timeline-ghost-label');
    expect(label).toHaveTextContent(t('timeline.clipFrames', { start: 20, duration: 14 }));
    for (const trackId of ['v2', MAIN]) expect(dragGhost(trackId), trackId).toBe(null);
  });
});

describe('TimelineSpace visual round 2 (inner#1708 W13, W17, W19, W20)', () => {
  it.each([
    ['timeline-toggle-magnet', 'timeline.edit.magnet', null],
    ['timeline-toggle-snap', 'timeline.edit.snap', 'N'],
    ['timeline-toggle-linkage', 'timeline.edit.linkage', null],
  ] as const)('draws %s as an icon button named by its switch, with a tooltip (W13)', async (testId, label, key) => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    const button = screen.getByTestId(testId);
    expect(button).toBe(screen.getByRole('button', { name: t(label) }));
    expect(button.textContent?.trim()).toBe('');
    const pressed = button.getAttribute('aria-pressed');
    expect(pressed === 'true' || pressed === 'false').toBe(true);
    act(() => button.focus());
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(t(label));
    if (key !== null) expect(tooltip).toHaveTextContent(key);
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true');
  });

  it('renders Add media disabled for a Viewer, like the other edit buttons (W17)', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline({ ...CONNECTED, writeAccess: 'denied' }, true);
    await screen.findByTestId('timeline-clip-' + X);
    for (const testId of ['timeline-add-media', 'timeline-undo', 'timeline-redo', 'timeline-split', 'timeline-duplicate', 'timeline-delete']) {
      expect(screen.getByTestId(testId), testId).toBeDisabled();
    }
  });

  it('keeps Add media enabled for an Editor (W17)', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    expect(screen.getByTestId('timeline-add-media')).toBeEnabled();
  });

  it('shows the selected conflicting clip\'s first reason in its properties (W19)', async () => {
    seedConflictingClips();
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-conflict-' + CLIP.id));
    const area = within(properties());
    expect(area.getByText(t('timeline.conflict'), { exact: true })).toBeInTheDocument();
    expect(area.getByText(t('timeline.conflictReason.overlap'), { exact: true })).toBeInTheDocument();
  });

  it('shows neither the conflict word nor a reason in a ready clip\'s properties (W19)', async () => {
    seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const ready = within(properties());
    expect(ready.queryByText(t('timeline.conflict'), { exact: true })).toBe(null);
    expect(ready.queryByText(t('timeline.conflictReason.overlap'), { exact: true })).toBe(null);
  });

  it.each([
    ['a sub track', 'v2', (): string => t('timeline.track', { index: 2 })],
    ['the main track', MAIN, (): string => t('timeline.mainTrack')],
  ] as const)('starts a conflict row\'s frames line with the name of %s (W20)', async (_name, trackId, name) => {
    const doc = seedLayout([]);
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      write(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: { ...CLIP, trackId } }, placement: OFF });
      write(peer, { operation: 'add_video', parameters: { source: SOURCE, clip: { ...CLIP, id: Y2, trackId } }, placement: OFF });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'provider');
    } finally { peer.destroy(); }
    showTimeline();
    const row = await screen.findByTestId('timeline-conflict-' + CLIP.id);
    expect(within(row).getByText(`${name()} · ${t('timeline.clipFrames', { start: 0, duration: 48 })}`, { exact: true })).toBeInTheDocument();
  });

  it('names a removed track in a conflict row\'s frames line (W20)', async () => {
    const doc = seedLayout([clipAt(X, 'v2', 10, 14)]);
    showTimeline();
    await screen.findByTestId('timeline-clip-' + X);
    act(() => { doc.transact(() => doc.getMap('tracks').delete('v2'), 'provider'); });
    const row = await screen.findByTestId('timeline-conflict-' + X);
    expect(within(row).getByText(`${t('timeline.edit.trackRemoved')} · ${t('timeline.clipFrames', { start: 10, duration: 14 })}`, { exact: true })).toBeInTheDocument();
  });
});

describe('TimelineSpace size cap (inner#1790)', () => {
  afterEach(() => { clearAllDocSizes(); });

  it('TL-Q12 a refused edit in a full Space shows one toast, from writeSpaceDoc, and writes nothing', async () => {
    const doc = seedLayout([clipAt(CLIP.id, MAIN, 0, 48)]);
    showTimeline();
    const clip = await screen.findByTestId('timeline-clip-' + CLIP.id);
    fireEvent.click(clip);
    enterSize(docName.timelineSpace(PROJECT, SPACE), 'F');
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    fireEvent.click(screen.getByTestId('timeline-duplicate'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(vi.mocked(toast.warning).mock.calls.map(([message]) => message)).toEqual([SIZE_COPY_EN.T_ADD]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

/**
 * Selecting, moving and noting layers in the preview (breatic#1410 design §4, §6.2).
 *
 * The preview frame (`timeline-preview`) clips the layers; above it the operation layer (`timeline-layer-overlay`,
 * absent for a Viewer) holds the hit layer (`timeline-layer-hit`, which takes clicks and drag starts) and, for a
 * selected editable layer that is visible and ready, `TimelineLayerHandles` (loaded on demand; `react-moveable` is
 * mocked here); above that the note layer (`timeline-preview-notes`) holds every per-layer note, a video's included.
 * jsdom lays nothing out, so the frame and its layers measure 960 x 540 display pixels here: half the 1920 x 1080
 * canvas. ASSET is 1280 x 720, so every video's base box is the whole canvas.
 */
describe('TimelineSpace preview layers (breatic#1410)', () => {
  // A picture-in-picture in the top-right quarter: centre a quarter frame right of and above the frame centre, canvas box
  // x 1200..1680, y 135..405; display centre (720, 135).
  const PIP = { frameX: 0.25, frameY: -0.25, scaleX: 0.25, scaleY: 0.25, rotation: 0 };
  const PIP_CENTRE = [720, 135] as const;
  // Inside the full-frame CLIP only.
  const BACKGROUND = [100, 400] as const;
  const PREVIEW_PARTS = new Set(['timeline-preview', 'timeline-layer-overlay', 'timeline-layer-hit', 'timeline-preview-notes']);
  // The area the preview is fitted into, 1px border included on each side: the 1920 x 1080 frame shows at 960 x 540
  // (breatic#1502 design §6.2).
  const AREA = { width: 962, height: 542 };
  const SOURCE_B: TimelineVideoSource = { ...SOURCE, id: '10000000-0000-4000-8000-000000000002', assetId: LOCAL_ASSET.assetId };

  beforeEach(() => {
    resetMoveableMock();
    const rect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.testid === 'timeline-preview-area') {
        return { x: 0, y: 0, left: 0, top: 0, right: AREA.width, bottom: AREA.height, width: AREA.width, height: AREA.height, toJSON: () => ({}) } as DOMRect;
      }
      if (this instanceof HTMLElement && PREVIEW_PARTS.has(this.dataset.testid ?? '')) {
        return { x: 0, y: 0, left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540, toJSON: () => ({}) } as DOMRect;
      }
      return rect.call(this);
    });
    const sized = (getter: (() => number) | undefined, size: number, areaSize: number) => function (this: Element): number {
      if (this instanceof HTMLElement && this.dataset.testid === 'timeline-preview-area') return areaSize;
      if (this instanceof HTMLElement && PREVIEW_PARTS.has(this.dataset.testid ?? '')) return size;
      return getter === undefined ? 0 : getter.call(this);
    };
    // Each original getter is read before its spy replaces it.
    for (const [name, size, areaSize] of [['clientWidth', 960, AREA.width], ['clientHeight', 540, AREA.height]] as const) {
      const getter = sized(Object.getOwnPropertyDescriptor(Element.prototype, name)?.get, size, areaSize);
      vi.spyOn(Element.prototype, name, 'get').mockImplementation(getter);
    }
    for (const [name, size, areaSize] of [['offsetWidth', 960, AREA.width], ['offsetHeight', 540, AREA.height]] as const) {
      const getter = sized(Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)?.get, size, areaSize);
      vi.spyOn(HTMLElement.prototype, name, 'get').mockImplementation(getter);
    }
  });

  /**
   * Seed the full-frame CLIP on the main track and the picture-in-picture X above it, both from frame 0.
   * @param fields - Overrides for X.
   * @returns The client document.
   * @throws {Error} When the fixture is invalid.
   */
  function seedPip(fields: Partial<TimelineVideoClip> = {}): Y.Doc {
    return seedLayout([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 0, 24, { transform: PIP, ...fields })]);
  }

  /**
   * Click the preview's hit layer at display coordinates.
   * @param point - The point, from the frame's top left.
   * @throws {Error} When the hit layer is absent.
   */
  function clickPreview(point: readonly [number, number]): void {
    const hit = screen.getByTestId('timeline-layer-hit');
    const init = { clientX: point[0], clientY: point[1], button: 0, buttons: 1, isPrimary: true, pointerId: 1 };
    fireEvent.pointerDown(hit, init);
    fireEvent.mouseDown(hit, init);
    fireEvent.pointerUp(hit, { ...init, buttons: 0 });
    fireEvent.mouseUp(hit, { ...init, buttons: 0 });
    fireEvent.click(hit, { ...init, buttons: 0 });
  }

  /**
   * Press a control the way a mouse does.
   * @param element - The control.
   * @throws {Error} When a handler throws.
   */
  function mouseClick(element: Element): void {
    const init = { button: 0, buttons: 1, isPrimary: true, pointerId: 1 };
    fireEvent.pointerDown(element, init);
    fireEvent.mouseDown(element, init);
    fireEvent.pointerUp(element, { ...init, buttons: 0 });
    fireEvent.mouseUp(element, { ...init, buttons: 0 });
    fireEvent.click(element, { ...init, buttons: 0 });
  }

  /**
   * Whether the track shows a clip selected.
   * @param clipId - The clip.
   * @returns Its pressed state.
   * @throws {Error} When the clip is absent.
   */
  function selectedOnTrack(clipId: string): string | null {
    return screen.getByTestId('timeline-clip-' + clipId).getAttribute('aria-pressed');
  }

  /**
   * Wait until each video layer is ready: its asset was read and the element got its `src` (design §4.2 makes only a
   * ready video pickable).
   * @param clipIds - The clips.
   * @throws {Error} When one never becomes ready.
   */
  async function layersReady(...clipIds: string[]): Promise<void> {
    await waitFor(() => { for (const clipId of clipIds) expect(previewVideo(clipId).getAttribute('src')).toBeTruthy(); });
  }

  /**
   * Wait until the handles of the selected layer are mounted.
   * @throws {Error} When they never mount.
   */
  async function handlesShown(): Promise<void> {
    await waitFor(() => expect(moveableMock.mounted).toBe(1));
  }

  /**
   * Count this client's own writes from now on.
   * @param doc - The document.
   * @returns The count so far.
   * @throws {never} Never.
   */
  function countOwnWrites(doc: Y.Doc): () => number {
    let own = 0;
    doc.on('update', (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => { if (transaction.local) own += 1; });
    return () => own;
  }

  /**
   * Delete a clip in another user's copy and deliver it here.
   * @param doc - This client's document.
   * @param clipId - The clip.
   * @throws {Error} When the peer refuses the delete.
   */
  function peerDeletes(doc: Y.Doc, clipId: string): void {
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      const vector = Y.encodeStateVector(doc);
      write(peer, { operation: 'delete', parameters: { clipId }, placement: OFF });
      act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, vector), 'remote-provider'));
    } finally { peer.destroy(); }
  }

  it('selects the topmost layer under a click, the same clip the track selects', async () => {
    seedPip();
    showTimeline();
    await layersReady(X, CLIP.id);
    clickPreview(PIP_CENTRE);
    await waitFor(() => expect(selectedOnTrack(X)).toBe('true'));
    expect(selectedOnTrack(CLIP.id)).toBe('false');
    await handlesShown();
    clickPreview(BACKGROUND);
    await waitFor(() => expect(selectedOnTrack(CLIP.id)).toBe('true'));
    expect(selectedOnTrack(X)).toBe('false');
  });

  it('clears the selection for a click outside every layer', async () => {
    seedLayout([clipAt(X, 'v2', 0, 24, { transform: PIP })]);
    showTimeline();
    await layersReady(X);
    clickPreview(PIP_CENTRE);
    await waitFor(() => expect(selectedOnTrack(X)).toBe('true'));
    clickPreview(BACKGROUND);
    await waitFor(() => expect(selectedOnTrack(X)).toBe('false'));
    expect(screen.getByText(t('timeline.selectClip'))).toBeInTheDocument();
  });

  it('re-picks the picture-in-picture from a press inside the selected full-frame layer that did not move', async () => {
    seedPip();
    showTimeline();
    await layersReady(X, CLIP.id);
    clickPreview(BACKGROUND);
    await waitFor(() => expect(selectedOnTrack(CLIP.id)).toBe('true'));
    await handlesShown();
    gesture.click(...PIP_CENTRE);
    await waitFor(() => expect(selectedOnTrack(X)).toBe('true'));
    expect(selectedOnTrack(CLIP.id)).toBe('false');
  });

  it('commits an entry left in the old clip\'s field before a preview click selects another clip', async () => {
    seedPip();
    showTimeline();
    await layersReady(CLIP.id);
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    const field = await screen.findByTestId('timeline-clip-x');
    field.focus();
    fireEvent.change(field, { target: { value: '0' } });
    clickPreview(BACKGROUND);
    await waitFor(() => expect(selectedOnTrack(CLIP.id)).toBe('true'));
    expect(layout().clips[X]?.transform).toEqual({ ...PIP, frameX: 0 });
  });

  it('shows no handles for a clip selected outside the current frame and keeps its fields editable', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 30, 14, { transform: PIP })]);
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    expect(await screen.findByTestId('timeline-clip-x')).toBeInstanceOf(HTMLInputElement);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(moveableMock.mounted).toBe(0);
    // The handles do load, for a selected clip in the current frame.
    fireEvent.click(screen.getByTestId('timeline-clip-' + CLIP.id));
    await handlesShown();
  });

  it('notes in the properties that a clip selected outside the current frame is not at it, and drops the note for one that is', async () => {
    seedLayout([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 30, 14, { transform: PIP })]);
    showTimeline();
    await layersReady(CLIP.id);
    fireEvent.click(await screen.findByTestId('timeline-clip-' + X));
    expect(await screen.findByTestId('timeline-clip-off-frame')).toHaveTextContent('This clip is not at the current frame.');
    fireEvent.click(screen.getByTestId('timeline-clip-' + CLIP.id));
    await waitFor(() => expect(selectedOnTrack(CLIP.id)).toBe('true'));
    expect(await screen.findByTestId('timeline-clip-x')).toBeInstanceOf(HTMLInputElement);
    expect(screen.queryByTestId('timeline-clip-off-frame')).toBe(null);
  });

  it('moves the layer itself while dragging, writes nothing until release, then one set_transform that undo reverts', async () => {
    const doc = seedPip();
    showTimeline();
    await layersReady(X);
    clickPreview(PIP_CENTRE);
    await handlesShown();
    const before = previewVideo(X).style.transform;
    const own = countOwnWrites(doc);
    gesture.dragStart();
    const last = gesture.drag([10, 10], [240, -135]);
    const proxy = screen.getByTestId('timeline-layer-proxy');
    expect(previewVideo(X).style.transform).not.toBe(before);
    expect(previewVideo(X).style.transform).toBe(proxy.style.transform);
    expect(own()).toBe(0);
    gesture.dragEnd(last);
    // 500 x -250 canvas pixels: 500 / 1920 and -250 / 1080 of the frame, rounded to 0.00001.
    await waitFor(() => expect(layout().clips[X]?.transform).toEqual({ ...PIP, frameX: 0.26042, frameY: -0.23148 }));
    expect(own()).toBe(1);
    expect(layout().clips[CLIP.id]?.transform).toEqual(CLIP.transform);
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[X]?.transform).toEqual(PIP));
  });

  it('does not undo during a preview drag; the drag is one undo step after release', async () => {
    seedPip();
    showTimeline();
    await layersReady(X);
    clickPreview(PIP_CENTRE);
    await screen.findByTestId('timeline-clip-rotation');
    commitField('timeline-clip-rotation', '10');
    await waitFor(() => expect(layout().clips[X]?.transform).toEqual({ ...PIP, rotation: 10 }));
    await handlesShown();
    gesture.dragStart();
    const last = gesture.drag([10, 10], [240, -135]);
    act(() => { fireEvent.keyDown(screen.getByTestId('timeline-space'), { key: 'z', metaKey: true }); });
    act(() => { fireEvent.keyDown(screen.getByTestId('timeline-space'), { key: 'z', ctrlKey: true }); });
    expect(layout().clips[X]?.transform).toEqual({ ...PIP, rotation: 10 });
    gesture.dragEnd(last);
    await waitFor(() => expect(layout().clips[X]?.transform).toEqual({ ...PIP, frameX: 0.26042, frameY: -0.23148, rotation: 10 }));
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[X]?.transform).toEqual({ ...PIP, rotation: 10 }));
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().clips[X]?.transform).toEqual(PIP));
  });

  it('ends the drag without writing and names the removal when a peer deletes the dragged clip; Delete works again', async () => {
    const doc = seedPip();
    showTimeline();
    await layersReady(X);
    clickPreview(PIP_CENTRE);
    await handlesShown();
    gesture.dragStart();
    gesture.drag([10, 10], [240, -135]);
    const own = countOwnWrites(doc);
    peerDeletes(doc, X);
    await waitFor(() => expect(moveableMock.mounted).toBe(0));
    expect(vi.mocked(toast.warning).mock.calls.map(([text]) => text)).toContain(t('timeline.errors.clip_removed'));
    expect(own()).toBe(0);
    const clip = screen.getByTestId('timeline-clip-' + CLIP.id);
    fireEvent.click(clip);
    act(() => { fireEvent.keyDown(clip, { key: 'Delete' }); });
    await waitFor(() => expect(layout().clips[CLIP.id]).toBe(undefined));
  });

  it('cancels a drag when the role turns Viewer: the layer returns, nothing is written, and the operation layer goes', async () => {
    const doc = seedPip();
    const { view, client } = showTimeline();
    await layersReady(X);
    clickPreview(PIP_CENTRE);
    await handlesShown();
    const before = previewVideo(X).style.transform;
    const own = countOwnWrites(doc);
    gesture.dragStart();
    gesture.drag([10, 10], [240, -135]);
    expect(previewVideo(X).style.transform).not.toBe(before);
    view.rerender(surface(client, { ...CONNECTED, writeAccess: 'denied' }, true));
    await waitFor(() => expect(screen.queryByTestId('timeline-layer-overlay')).toBe(null));
    expect(previewVideo(X).style.transform).toBe(before);
    expect(moveableMock.mounted).toBe(0);
    expect(own()).toBe(0);
    // Editing again, the shortcuts are not held by the cancelled drag.
    view.rerender(surface(client));
    const clip = screen.getByTestId('timeline-clip-' + CLIP.id);
    fireEvent.click(clip);
    act(() => { fireEvent.keyDown(clip, { key: 'Delete' }); });
    await waitFor(() => expect(layout().clips[CLIP.id]).toBe(undefined));
  });

  it('gives a Viewer no operation layer and no handles, and shows the placement', async () => {
    seedPip();
    showTimeline({ ...CONNECTED, writeAccess: 'denied' }, true);
    await waitFor(() => previewVideo(X));
    expect(screen.queryByTestId('timeline-layer-overlay')).toBe(null);
    expect(screen.queryByTestId('timeline-layer-hit')).toBe(null);
    const frame = screen.getByTestId('timeline-preview');
    fireEvent.pointerDown(frame, { clientX: PIP_CENTRE[0], clientY: PIP_CENTRE[1], button: 0, buttons: 1, isPrimary: true, pointerId: 1 });
    fireEvent.click(frame, { clientX: PIP_CENTRE[0], clientY: PIP_CENTRE[1] });
    expect(selectedOnTrack(X)).toBe('false');
    fireEvent.click(screen.getByTestId('timeline-clip-' + X));
    expect(screen.getByTestId('timeline-clip-x')).not.toBeInstanceOf(HTMLInputElement);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(moveableMock.mounted).toBe(0);
    expect(previewVideo(X).style.transform).toMatch(/translate\(\s*240px,\s*-135px\s*\)/);
  });

  it('fits a 9:16 frame into the same area and draws each layer at its frame fractions times the fitted size (breatic#1502 design §4, §6.2)', async () => {
    seedPip();
    showTimeline();
    await layersReady(X);
    // 16:9 in the 960 x 540 area inside the border: 0.5 display pixels per canvas pixel; 0.25 x 1920 x 0.5 = 240.
    expect(translateOf(previewVideo(X).style.transform)).toEqual([expect.closeTo(240, 6), expect.closeTo(-135, 6)]);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('timeline-frame-ratio'));
    await user.click(await screen.findByRole('option', { name: '9:16 · 1080×1920' }));
    await waitFor(() => expect(layout().settings).toMatchObject({ width: 1080, height: 1920 }));
    // 9:16 fits by height: min(960 / 1080, 540 / 1920) = 0.28125; the centre stays a quarter frame right of and above the
    // frame centre: 0.25 x 1080 x 0.28125 = 75.9375 and -0.25 x 1920 x 0.28125 = -135.
    await waitFor(() => expect(translateOf(previewVideo(X).style.transform)).toEqual([expect.closeTo(75.9375, 6), expect.closeTo(-135, 6)]));
    expect(layout().clips[X]?.transform).toEqual(PIP);
  });

  it('notes a loading or unavailable video by its track in the note layer, retries only it, and keeps the selection', async () => {
    let localCalls = 0;
    const pending = deferred<ProjectRegisteredAsset>();
    vi.mocked(timelineApi.resolveAsset).mockImplementation(async (_projectId, assetId) => {
      if (assetId !== LOCAL_ASSET.assetId) return ASSET;
      localCalls += 1;
      return localCalls === 1 ? pending.promise : LOCAL_ASSET;
    });
    const server = seededDoc(timeline([clipAt(CLIP.id, MAIN, 0, 48), clipAt(X, 'v2', 0, 24, { sourceId: SOURCE_B.id, transform: PIP })], [track(MAIN, 0), track('v2', 1)], [SOURCE, SOURCE_B]));
    try { Y.applyUpdate(currentDoc(), Y.encodeStateAsUpdate(server), 'provider'); } finally { server.destroy(); }
    showTimeline();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + CLIP.id));
    const notes = await screen.findByTestId('timeline-preview-notes');
    const loading = await waitFor(() => within(notes).getByTestId('timeline-preview-note-' + X));
    expect(loading).toHaveTextContent(t('timeline.track', { index: 2 }));
    await act(async () => { pending.reject(new Error('unreachable')); });
    const retry = await waitFor(() => within(notes).getByTestId('timeline-video-retry-' + X));
    expect(within(notes).getByTestId('timeline-preview-note-' + X)).toHaveTextContent(t('timeline.track', { index: 2 }));
    expect(screen.queryByText(t('timeline.mediaUnavailable'))).toBe(null);
    // The other layer is untouched by the failure.
    expect(previewVideo(CLIP.id)).toHaveAttribute('src', ASSET.fileUrl);
    expect(screen.queryByTestId('timeline-layer-overlay')?.contains(retry) ?? false).toBe(false);
    mouseClick(retry);
    await waitFor(() => expect(localCalls).toBe(2));
    await waitFor(() => expect(previewVideo(X)).toHaveAttribute('src', LOCAL_ASSET.fileUrl));
    expect(selectedOnTrack(CLIP.id)).toBe('true');
  });

  /**
   * Seed the full-frame CLIP (the default asset) on the main track and the picture-in-picture X (LOCAL_ASSET) above it.
   * @param withClip - Whether CLIP is there under X.
   * @throws {Error} When the fixture is invalid.
   */
  function seedPipOwnAsset(withClip = true): void {
    const pip = clipAt(X, 'v2', 0, 24, { sourceId: SOURCE_B.id, transform: PIP });
    const server = seededDoc(timeline(withClip ? [clipAt(CLIP.id, MAIN, 0, 48), pip] : [pip], [track(MAIN, 0), track('v2', 1)], [SOURCE, SOURCE_B]));
    try { Y.applyUpdate(currentDoc(), Y.encodeStateAsUpdate(server), 'provider'); } finally { server.destroy(); }
  }

  it('picks the lower ready layer, not an upper video whose asset read failed, and gives the failed one no handles (§4.2)', async () => {
    vi.mocked(timelineApi.resolveAsset).mockImplementation(async (_projectId, assetId) => {
      if (assetId === LOCAL_ASSET.assetId) throw new Error('unreachable');
      return ASSET;
    });
    seedPipOwnAsset();
    showTimeline();
    await waitFor(() => expect(previewVideo(CLIP.id)).toHaveAttribute('src', ASSET.fileUrl));
    await waitFor(() => screen.getByTestId('timeline-video-retry-' + X));
    clickPreview(PIP_CENTRE);
    await waitFor(() => expect(selectedOnTrack(CLIP.id)).toBe('true'));
    expect(selectedOnTrack(X)).toBe('false');
    await handlesShown();
    // Selected from its track, the failed layer still gets no handles.
    fireEvent.click(screen.getByTestId('timeline-clip-' + X));
    expect(selectedOnTrack(X)).toBe('true');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(moveableMock.mounted).toBe(0);
  });

  it('picks the lower ready layer, not an upper video whose element failed to load, and gives the failed one no handles (§4.2)', async () => {
    seedPip();
    showTimeline();
    await layersReady(X, CLIP.id);
    const failed = previewVideo(X);
    Object.defineProperty(failed, 'error', { configurable: true, value: { code: 4 } });
    fireEvent(failed, new Event('error'));
    await waitFor(() => screen.getByTestId('timeline-video-retry-' + X));
    clickPreview(PIP_CENTRE);
    await waitFor(() => expect(selectedOnTrack(CLIP.id)).toBe('true'));
    expect(selectedOnTrack(X)).toBe('false');
    await handlesShown();
    // Selected from its track, the failed layer still gets no handles.
    fireEvent.click(screen.getByTestId('timeline-clip-' + X));
    expect(selectedOnTrack(X)).toBe('true');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(moveableMock.mounted).toBe(0);
  });

  it('selects nothing for a click on a video whose asset is still loading, and gives it no handles (§4.2)', async () => {
    const pending = deferred<ProjectRegisteredAsset>();
    vi.mocked(timelineApi.resolveAsset).mockImplementation(async (_projectId, assetId) => assetId === LOCAL_ASSET.assetId ? pending.promise : ASSET);
    seedPipOwnAsset(false);
    showTimeline();
    const notes = await screen.findByTestId('timeline-preview-notes');
    await waitFor(() => within(notes).getByTestId('timeline-preview-note-' + X));
    clickPreview(PIP_CENTRE);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(selectedOnTrack(X)).toBe('false');
    expect(screen.getByText(t('timeline.selectClip'))).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('timeline-clip-' + X));
    expect(selectedOnTrack(X)).toBe('true');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(moveableMock.mounted).toBe(0);
  });

  it('gives the preview frame its own stacking context, so layer z-indexes stay under the operation and note layers (§4.1)', async () => {
    seedPip();
    showTimeline();
    await waitFor(() => previewVideo(X));
    expect(screen.getByTestId('timeline-preview')).toHaveClass('isolate');
  });

  it('keeps a video ready, with no unavailable note, when a refetch of its asset fails while its data is cached (§6.2)', async () => {
    let localCalls = 0;
    vi.mocked(timelineApi.resolveAsset).mockImplementation(async (_projectId, assetId) => {
      if (assetId !== LOCAL_ASSET.assetId) return ASSET;
      localCalls += 1;
      if (localCalls === 1) return LOCAL_ASSET;
      throw new Error('unreachable');
    });
    seedPipOwnAsset();
    const { client } = showTimeline();
    await waitFor(() => expect(previewVideo(X)).toHaveAttribute('src', LOCAL_ASSET.fileUrl));
    const key = timelineAssetKey(PROJECT, LOCAL_ASSET.assetId);
    await act(async () => { await client.refetchQueries({ queryKey: key }); });
    expect(localCalls).toBe(2);
    expect(client.getQueryState(key)?.status).toBe('error');
    expect(client.getQueryData(key)).toEqual(LOCAL_ASSET);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(screen.queryByTestId('timeline-preview-note-' + X)).toBe(null);
    expect(screen.queryByTestId('timeline-video-retry-' + X)).toBe(null);
    expect(previewVideo(X)).toHaveAttribute('src', LOCAL_ASSET.fileUrl);
  });
});

/**
 * The display translation of a layer CSS transform.
 * @param css - The `transform` value.
 * @returns Its x and y in display pixels.
 * @throws {Error} When it has no translate.
 */
function translateOf(css: string): [number, number] {
  const match = /translate\(\s*(-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\s*\)/.exec(css);
  if (match === null) throw new Error(`No translate in ${css}`);
  return [Number(match[1]), Number(match[2])];
}

/**
 * The frame ratio control and the play bar (breatic#1502 design §6.1, §3.3, §8). The play bar under the preview
 * carries `data-playback-state` (`paused`, `playing`, `waiting`) and no longer names the paused or playing state in
 * text; "Buffering…" shows only while waiting. A `Select` (`data-testid="timeline-frame-ratio"`) at its right end lists
 * the seven presets, each as "ratio · width×height", shows the current one (nothing for a size outside the seven), is
 * disabled for a Viewer, and choosing a preset writes one `set_frame` that undo takes back.
 */
describe('TimelineSpace frame ratio and play bar (breatic#1502)', () => {
  const OPTIONS = ['16:9 · 1920×1080', '9:16 · 1080×1920', '1:1 · 1080×1080', '4:3 · 1440×1080', '4:5 · 1080×1350', '2:3 · 1080×1620', '21:9 · 2520×1080'];

  /**
   * Seed a document whose frame is this size.
   * @param width - Frame width.
   * @param height - Frame height.
   * @returns The client document.
   * @throws {Error} When the seed cannot be applied.
   */
  function seedFrame(width: number, height: number): Y.Doc {
    const server = new Y.Doc();
    try {
      initializeTimelineDocument(server, { ...SETTINGS, width, height });
      Y.applyUpdate(currentDoc(), Y.encodeStateAsUpdate(server), 'provider');
      return currentDoc();
    } finally { server.destroy(); }
  }

  /**
   * The play bar under the preview.
   * @returns The row holding the play button.
   * @throws {Error} When there is none.
   */
  function playBar(): HTMLElement {
    const row = screen.getByTestId('timeline-play').closest<HTMLElement>('[data-playback-state]');
    if (row === null) throw new Error('The play button is in no row with data-playback-state');
    return row;
  }

  it('puts the ratio control at the right end of the play bar, showing the current preset', async () => {
    seedContent();
    showTimeline();
    const trigger = await screen.findByTestId('timeline-frame-ratio');
    const row = playBar();
    expect(row.contains(trigger)).toBe(true);
    expect(row.lastElementChild?.contains(trigger)).toBe(true);
    expect(trigger).toHaveTextContent('16:9 · 1920×1080');
    expect(trigger).toBeEnabled();
  });

  it('lists the seven presets with their sizes, in order', async () => {
    seedContent();
    showTimeline();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('timeline-frame-ratio'));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent?.trim())).toEqual(OPTIONS);
  });

  it('writes the chosen preset as one step: the frame changes, clips stay, and undo brings the old frame back', async () => {
    seedLayout([CLIP]);
    showTimeline();
    const user = userEvent.setup();
    const before = layout();
    await user.click(await screen.findByTestId('timeline-frame-ratio'));
    await user.click(await screen.findByRole('option', { name: '9:16 · 1080×1920' }));
    await waitFor(() => expect(layout().settings).toEqual({ ...SETTINGS, width: 1080, height: 1920 }));
    expect(layout().clips).toEqual(before.clips);
    expect(screen.getByTestId('timeline-frame-ratio')).toHaveTextContent('9:16 · 1080×1920');
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(layout().settings).toEqual(SETTINGS));
    expect(screen.getByTestId('timeline-frame-ratio')).toHaveTextContent('16:9 · 1920×1080');
    expect(screen.getByTestId('timeline-undo')).toBeDisabled();
  });

  it('writes nothing for the preset already in use', async () => {
    const doc = seedContent();
    showTimeline();
    const user = userEvent.setup();
    const before = Y.encodeStateAsUpdate(doc);
    await user.click(await screen.findByTestId('timeline-frame-ratio'));
    await user.click(await screen.findByRole('option', { name: '16:9 · 1920×1080' }));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(screen.getByTestId('timeline-undo')).toBeDisabled();
  });

  it('shows a Viewer the current preset in a disabled control that writes nothing', async () => {
    const doc = seedFrame(1080, 1350);
    showTimeline({ ...CONNECTED, writeAccess: 'denied' }, true);
    const trigger = await screen.findByTestId('timeline-frame-ratio');
    expect(trigger).toHaveTextContent('4:5 · 1080×1350');
    expect(trigger).toBeDisabled();
    const before = Y.encodeStateAsUpdate(doc);
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('shows nothing for a frame size outside the seven presets, previews it, and changes it to any preset chosen', async () => {
    seedFrame(1280, 720);
    showTimeline();
    const trigger = await screen.findByTestId('timeline-frame-ratio');
    expect(trigger.textContent?.trim()).toBe('');
    expect(screen.getByTestId('timeline-preview')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: '1:1 · 1080×1080' }));
    await waitFor(() => expect(layout().settings).toEqual({ ...SETTINGS, width: 1080, height: 1080 }));
  });

  it('shows the preset a collaborator chose as soon as it arrives', async () => {
    const doc = seedContent();
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      showTimeline();
      expect(await screen.findByTestId('timeline-frame-ratio')).toHaveTextContent('16:9 · 1920×1080');
      const vector = Y.encodeStateVector(doc);
      write(peer, { operation: 'set_frame', parameters: { preset: '21:9' }, placement: OFF });
      act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, vector), 'remote-provider'));
      await waitFor(() => expect(screen.getByTestId('timeline-frame-ratio')).toHaveTextContent('21:9 · 2520×1080'));
    } finally { peer.destroy(); }
  });

  it('marks the play bar paused and names neither paused nor playing in text', async () => {
    seedContent();
    showTimeline();
    await screen.findByTestId('timeline-play');
    expect(playBar()).toHaveAttribute('data-playback-state', 'paused');
    expect(within(playBar()).queryByText('Paused')).toBe(null);
    expect(within(playBar()).queryByText('Playing')).toBe(null);
    expect(within(playBar()).queryByText(t('timeline.transport.waiting'))).toBe(null);
  });

  it('removes the paused and playing transport strings from every locale', () => {
    for (const [locale, catalog] of LOCALE_CATALOGS) {
      expect(readPath(catalog, 'timeline.transport.paused'), locale).toBeUndefined();
      expect(readPath(catalog, 'timeline.transport.playing'), locale).toBeUndefined();
      expect(typeof readPath(catalog, 'timeline.transport.waiting'), locale).toBe('string');
    }
  });
});
