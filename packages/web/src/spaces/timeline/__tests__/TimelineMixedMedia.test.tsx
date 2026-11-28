// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Timeline Space with text, picture and sound clips beside videos (inner#1709 design §2.3, §2.4, §3.1, §3.5, §4.5,
 * §5, §6, §7.4-§7.7), driven through the real Space body in zh-CN, whose sentences the design names.
 *
 * The network is faked at its two edges: `apiGet` answers the Project asset list by `kind`, each asset read and the
 * Timeline limits (with `media` and `text.fontBaseUrl`); `fetch` answers the font set's `faces.json` and
 * `glyphs.json`. `FontFace`, `document.fonts` and `AudioContext` are recorded fakes, and `HTMLImageElement.decode`
 * is controlled per case. Each case reads its own font set version, so the page-wide font registry of one case is not
 * the next case's.
 */

import { NODE_TYPE_PALETTE } from '@web/spaces/canvas/node-type-palette';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { setLocale, TIMELINE_PREVIEW_DEFAULTS, type ProjectRegisteredAsset } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { apiGet } from '@web/data/api/request';
import { timelineMediaQueryKey } from '@web/data/api/timeline';
import type * as RequestModule from '@web/data/api/request';
import { ApiException } from '@web/data/api/types';
import { handOffSpaceMedia } from '@web/data/upload/media-upload';
import type * as MediaUploadModule from '@web/data/upload/media-upload';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import type { SocketState } from '@web/data/yjs/use-socket';
import { toast } from '@web/lib/toast';
import { writeUserPreference } from '@web/lib/user-preferences-storage';
import { formatShortcut } from '@web/spaces/canvas/format-shortcut';
import { TimelineSpace } from '@web/spaces/timeline/TimelineSpace';
import { useCurrentUserStore, useUIStore } from '@web/stores';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { useTimelineEditPrefsStore } from '@web/stores/timeline-edit-prefs';

vi.mock('@web/data/api/request', async (importOriginal) => ({ ...(await importOriginal<typeof RequestModule>()), apiGet: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaUploadModule>()),
  uploadMedia: vi.fn(() => new Promise(() => undefined)),
  handOffSpaceMedia: vi.fn(() => new Promise(() => undefined)),
}));

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const OTHER_SPACE = '70000000-0000-4000-8000-000000000002';
const MAIN = 'visual-1';
const FPS = { num: 24, den: 1 };
const SETTINGS = { width: 1920, height: 1080, fps: FPS };
const ME = 'user-timeline-editor';
const CONNECTED: SocketState = {
  provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null,
};
const PLACED = { sourceInFrame: 0, rate: { num: 1, den: 1 }, gain: 1, mute: false, transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 } };

/** A registered asset of one kind. */
function asset(n: number, kind: 'video' | 'image' | 'audio', displayName: string, fields: Partial<ProjectRegisteredAsset> = {}): ProjectRegisteredAsset {
  return {
    assetId: `20000000-0000-4000-8000-00000000000${n}`, projectReferenceId: `50000000-0000-4000-8000-00000000000${n}`, displayName, kind,
    fileUrl: `https://cdn.example/${kind}-${n}`, coverUrl: kind === 'video' ? `https://cdn.example/${kind}-${n}.jpg` : null,
    width: kind === 'audio' ? null : 1920, height: kind === 'audio' ? null : 1080, durationSeconds: kind === 'image' ? null : 14,
    mimeType: kind === 'video' ? 'video/mp4' : kind === 'image' ? 'image/png' : 'audio/mpeg', sizeBytes: 4096, ...fields,
  };
}
const VIDEO_ASSET = asset(1, 'video', '镜头1-开场.mp4');
const IMAGE_ASSET = asset(2, 'image', '镜头2-生成图.png');
const AUDIO_ASSET = asset(3, 'audio', '配乐-轻快.mp3');
const ASSETS = new Map([VIDEO_ASSET, IMAGE_ASSET, AUDIO_ASSET].map((item) => [item.assetId, item]));

// Each source holds its file's address and media facts, as the list item it was picked from (inner#2171).
const VIDEO_SOURCE = {
  id: '10000000-0000-4000-8000-000000000001', kind: 'video', url: VIDEO_ASSET.fileUrl, coverUrl: VIDEO_ASSET.coverUrl, name: VIDEO_ASSET.displayName,
  mimeType: VIDEO_ASSET.mimeType, width: 1920, height: 1080, timebase: FPS, extentFrames: 336, durationSeconds: '14', durationOrigin: 'registered',
};
const IMAGE_SOURCE = {
  id: '10000000-0000-4000-8000-000000000002', kind: 'image', url: IMAGE_ASSET.fileUrl, name: IMAGE_ASSET.displayName, mimeType: IMAGE_ASSET.mimeType,
  width: 1920, height: 1080,
};
const AUDIO_SOURCE = {
  id: '10000000-0000-4000-8000-000000000003', kind: 'audio', url: AUDIO_ASSET.fileUrl, name: AUDIO_ASSET.displayName, mimeType: AUDIO_ASSET.mimeType,
  timebase: FPS, extentFrames: 336, durationSeconds: '14', durationOrigin: 'registered',
};
const VIDEO = { ...PLACED, id: '30000000-0000-4000-8000-000000000001', kind: 'video', trackId: MAIN, sourceId: VIDEO_SOURCE.id, startFrame: 0, durationFrames: 48, mute: true };
const IMAGE = { ...PLACED, id: '30000000-0000-4000-8000-000000000002', kind: 'image', trackId: 'v2', sourceId: IMAGE_SOURCE.id, startFrame: 0, durationFrames: 72 };
const AUDIO = { ...PLACED, id: '30000000-0000-4000-8000-000000000003', kind: 'audio', trackId: 'v3', sourceId: AUDIO_SOURCE.id, startFrame: 0, durationFrames: 72, gain: 2 };
const TEXT = { ...PLACED, id: '30000000-0000-4000-8000-000000000004', kind: 'text', trackId: 'v2', startFrame: 0, durationFrames: 72, text: { body: '镜头 1：开场\n第二行', size: 0.06 } };

type Record_ = { id: string } & Record<string, unknown>;

// ---- Fonts: one version per case, so the page-wide registry of an earlier case is never reused. ----
let fontVersion = 100;
let fontBase = '';
const FACES = [
  { family: 'Inter', file: 'inter-latin-wght-normal', unicodeRange: 'U+0000-00FF', weight: '100 900' },
  { family: 'Noto Sans SC', file: 'noto-sans-sc-han-wght-normal', unicodeRange: 'U+4E00-9FFF,U+FF00-FFEF', weight: '100 900' },
];
let glyphs: unknown = [
  { file: 'inter-latin-wght-normal', glyphRange: 'U+0000-00FF' },
  { file: 'noto-sans-sc-han-wght-normal', glyphRange: 'U+4E00-9FFF,U+FF00-FFEF' },
];
/** How the next `FontFace.load()` of each slice ends, by file name; unlisted ones resolve at once. */
let fontOutcome: Map<string, 'pending' | 'reject'> = new Map();
const pendingFonts: Array<{ face: FakeFontFace; resolve: () => void }> = [];

/** A `FontFace` that records what it was made with and ends its load as the case says. */
class FakeFontFace {
  static made: FakeFontFace[] = [];
  status: 'unloaded' | 'loading' | 'loaded' | 'error' = 'unloaded';
  readonly unicodeRange: string;
  /**
   * Record the face.
   * @param family - The family name.
   * @param source - The `url(...)` source.
   * @param descriptors - The descriptors.
   */
  constructor(readonly family: string, readonly source: string, readonly descriptors: { unicodeRange?: string; weight?: string } = {}) {
    this.unicodeRange = descriptors.unicodeRange ?? 'U+0-10FFFF';
    FakeFontFace.made.push(this);
  }
  /**
   * Load the slice as the case says.
   * @returns The load.
   */
  load(): Promise<FakeFontFace> {
    this.status = 'loading';
    const outcome = [...fontOutcome].find(([file]) => this.source.includes(file))?.[1];
    if (outcome === 'reject') { this.status = 'error'; return Promise.reject(new DOMException('slice failed', 'NetworkError')); }
    if (outcome === 'pending') return new Promise((resolve) => { pendingFonts.push({ face: this, resolve: () => { this.status = 'loaded'; resolve(this); } }); });
    this.status = 'loaded';
    return Promise.resolve(this);
  }
}

/** The page's font set: what was added and deleted. */
const fontSet = { faces: new Set<FakeFontFace>(), add: vi.fn((face: FakeFontFace) => { fontSet.faces.add(face); }), delete: vi.fn((face: FakeFontFace) => fontSet.faces.delete(face)), has: (face: FakeFontFace) => fontSet.faces.has(face), check: () => true, ready: Promise.resolve() };

// ---- Sound: a recorded AudioContext. ----
interface FakeNode { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
interface FakeSource extends FakeNode { mediaElement: HTMLMediaElement; target: () => FakeGain | undefined }
interface FakeGain extends FakeNode { gain: { value: number } }
/** An `AudioContext` that records the graph built in it. */
class FakeAudioContext {
  static made: FakeAudioContext[] = [];
  state: AudioContextState = 'suspended';
  readonly destination = { kind: 'destination' };
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly resume = vi.fn(async () => { this.state = 'running'; });
  readonly close = vi.fn(async () => { this.state = 'closed'; });
  /** Record the context. */
  constructor() { FakeAudioContext.made.push(this); }
  /**
   * Record a source node.
   * @param mediaElement - Its element.
   * @returns The node.
   */
  createMediaElementSource(mediaElement: HTMLMediaElement): FakeSource {
    let target: FakeGain | undefined;
    const node: FakeSource = { mediaElement, target: () => target, connect: vi.fn((next: FakeGain) => { target = next; return next; }), disconnect: vi.fn() };
    this.sources.push(node);
    return node;
  }
  /**
   * Record a gain node.
   * @returns The node.
   */
  createGain(): FakeGain {
    const node: FakeGain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    this.gains.push(node);
    return node;
  }
  /**
   * The source node made for a clip's element.
   * @param clipId - The clip.
   * @returns The node.
   */
  sourceOf(clipId: string): FakeSource | undefined {
    return this.sources.find((node) => node.mediaElement.getAttribute('data-clip-id') === clipId);
  }
}

// ---- Pictures: decode() per case. ----
let decodeOutcome: 'resolve' | 'pending' | 'reject' = 'resolve';
const pendingDecodes: Array<() => void> = [];
let decodeDescriptor: PropertyDescriptor | undefined;
const decode = vi.fn(function decode(this: HTMLImageElement): Promise<void> {
  if (decodeOutcome === 'reject') return Promise.reject(new DOMException('decode failed', 'EncodingError'));
  if (decodeOutcome === 'pending') return new Promise<void>((resolve) => { pendingDecodes.push(resolve); });
  return Promise.resolve();
});
const clients: QueryClient[] = [];
let mediaElements: HTMLMediaElement[] = [];

/**
 * The manager-owned document of a Space.
 * @param spaceId - The Space.
 * @returns The document.
 */
function currentDoc(spaceId = SPACE): Y.Doc {
  return getDoc(docName.timelineSpace(PROJECT, spaceId));
}

/**
 * Attach a record map before setting its fields, as the production writer does.
 * @param parent - The collection map.
 * @param value - The record.
 */
function attach(parent: Y.Map<unknown>, value: Record_): void {
  const child = new Y.Map<unknown>();
  parent.set(value.id, child);
  for (const [key, item] of Object.entries(value)) child.set(key, item);
}

/**
 * Deliver a version 3 document holding these tracks, clips and sources, as the server would.
 * @param clips - The clips.
 * @param sources - The sources.
 * @param trackIds - The tracks bottom-up after the main track.
 * @param spaceId - The Space.
 * @returns The client document.
 */
function seed(clips: Record_[], sources: Record_[] = [VIDEO_SOURCE, IMAGE_SOURCE, AUDIO_SOURCE], trackIds: string[] = ['v2', 'v3'], spaceId = SPACE): Y.Doc {
  const server = new Y.Doc();
  try {
    server.transact(() => {
      const timeline = server.getMap('timeline');
      timeline.set('schemaVersion', 3);
      timeline.set('settings', SETTINGS);
      const tracks = server.getMap<unknown>('tracks');
      [MAIN, ...trackIds].forEach((id, order) => attach(tracks, { id, order }));
      const stored = server.getMap<unknown>('sources');
      for (const source of sources) stored.set(source.id, source);
      const records = server.getMap<unknown>('clips');
      for (const clip of clips) attach(records, clip);
    });
    Y.applyUpdate(currentDoc(spaceId), Y.encodeStateAsUpdate(server), 'provider');
    return currentDoc(spaceId);
  } finally { server.destroy(); }
}

/**
 * The stored clips as JSON.
 * @param spaceId - The Space.
 * @returns The clips by id.
 */
function storedClips(spaceId = SPACE): Record<string, Record<string, unknown>> {
  return currentDoc(spaceId).getMap('clips').toJSON() as Record<string, Record<string, unknown>>;
}

/**
 * The Space body inside the application contexts.
 * @param client - The query cache.
 * @param spaceId - The Space.
 * @param readOnly - Whether the role is Viewer.
 * @returns The tree.
 */
function body(client: QueryClient, spaceId = SPACE, readOnly = false): React.JSX.Element {
  return <QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={CONNECTED}>
    <div data-region='space'><TimelineSpace projectId={PROJECT} spaceId={spaceId} readOnly={readOnly} myRole={readOnly ? 'viewer' : 'editor'} /></div>
  </SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>;
}

/**
 * A query cache with no retries.
 * @returns The cache.
 */
function newClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  return client;
}

/**
 * Render the Timeline.
 * @param mode - The Space body's visibility, when a case switches it.
 * @returns The view and its cache.
 */
function show(mode?: 'visible' | 'hidden'): { view: RenderResult; client: QueryClient } {
  const client = newClient();
  const content = body(client);
  return { view: render(mode === undefined ? content : <React.Activity mode={mode}>{content}</React.Activity>), client };
}

/**
 * The play bar's transport state.
 * @returns `paused`, `waiting` or `playing`.
 */
function transport(root: ParentNode = document): string | null {
  return root.querySelector('[data-playback-state]')?.getAttribute('data-playback-state') ?? null;
}

/**
 * A preview layer of a clip (not its track card).
 * @param clipId - The clip.
 * @param root - Where to look.
 * @returns The layer, or null.
 */
function layerOf(clipId: string, root: ParentNode = screen.getByTestId('timeline-preview')): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-clip-id="${clipId}"]`);
}

/**
 * The created media element of a clip.
 * @param clipId - The clip.
 * @param tag - `audio` or `video`.
 * @returns The newest such element.
 */
function mediaOf(clipId: string, tag: 'audio' | 'video'): HTMLMediaElement | undefined {
  return mediaElements.filter((element) => element.localName === tag && element.getAttribute('data-clip-id') === clipId).at(-1);
}

/**
 * Seek the playhead with the seek slider's arrow key.
 * @param frames - How many frames forward.
 */
function seekForward(frames: number): void {
  const seek = screen.getAllByRole('slider')[0]!;
  seek.focus();
  for (let step = 0; step < frames; step += 1) fireEvent.keyDown(seek, { key: 'ArrowRight' });
}

beforeEach(() => {
  _resetForTests();
  setLocale('zh-CN');
  window.localStorage.clear();
  useTimelineEditPrefsStore.setState({ owner: null });
  useCurrentUserStore.setState({ user: { id: ME, name: 'Me', email: 'me@e.com', personalStudio: { name: 'Me', slug: 'me', avatarUrl: null }, membershipTier: 'base' } });
  useUIStore.setState({ activeRegion: 'space' });
  useSpaceOperationsStore.setState({ operations: {} });
  for (const fn of Object.values(toast)) if (vi.isMockFunction(fn)) fn.mockClear();
  fontVersion += 1;
  fontBase = `https://ingest.example/web-animation/fonts/v${fontVersion}/`;
  glyphs = [
    { file: 'inter-latin-wght-normal', glyphRange: 'U+0000-00FF' },
    { file: 'noto-sans-sc-han-wght-normal', glyphRange: 'U+4E00-9FFF,U+FF00-FFEF' },
  ];
  fontOutcome = new Map();
  pendingFonts.splice(0);
  FakeFontFace.made = [];
  FakeAudioContext.made = [];
  fontSet.faces.clear();
  fontSet.add.mockClear();
  fontSet.delete.mockClear();
  decodeOutcome = 'resolve';
  pendingDecodes.splice(0);
  mediaElements = [];
  vi.stubGlobal('FontFace', FakeFontFace);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  Object.defineProperty(document, 'fonts', { configurable: true, value: fontSet });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${fontBase}faces.json`) return new Response(JSON.stringify(FACES), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === `${fontBase}glyphs.json`) {
      return glyphs === null ? new Response('missing', { status: 404 }) : new Response(JSON.stringify(glyphs), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }));
  // jsdom has no decode(); the descriptor is restored after each case, as the unit-testing rules ask.
  decodeDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, writable: true, value: decode });
  const createElement = document.createElement.bind(document);
  // One signature: the overloads also list Electron's <webview> once Playwright loads its types.
  const doc = document as unknown as { createElement: (tagName: string, options?: ElementCreationOptions) => HTMLElement };
  vi.spyOn(doc, 'createElement').mockImplementation((tagName, options) => {
    const element = createElement(tagName, options);
    if (element instanceof HTMLMediaElement) mediaElements.push(element);
    return element;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.mocked(handOffSpaceMedia).mockReset().mockImplementation(() => new Promise(() => undefined));
  vi.mocked(apiGet).mockReset().mockImplementation(async (url: string, config?: { params?: { kind?: string } }) => {
    if (url === `/projects/${PROJECT}/timeline-limits`) {
      return {
        defaults: SETTINGS, assets: { pageSize: 50, pageMax: 100 },
        webAnimation: { promptMaxLength: 4000, durationSeconds: { min: 1, max: 60, default: 4 }, aspects: ['16:9'], playerLoadTimeoutMs: 15000, previewTokenTtlMs: 60000, premountMs: 2000, idleInstancesMax: 2 },
        preview: TIMELINE_PREVIEW_DEFAULTS,
        media: { imageDurationSeconds: 4, textDurationSeconds: 3, textSize: 0.07 },
        text: { fontBaseUrl: fontBase },
      };
    }
    if (url === `/projects/${PROJECT}/assets`) {
      const kind = config?.params?.kind;
      return { items: [...ASSETS.values()].filter((item) => item.kind === kind), nextCursor: null };
    }
    throw new ApiException({ status: 404, message: 'Not found' });
  });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  _resetForTests();
  setLocale('en');
  useCurrentUserStore.setState({ user: null });
  useSpaceOperationsStore.setState({ operations: {} });
  delete (document as unknown as { fonts?: unknown }).fonts;
  if (decodeDescriptor === undefined) delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
  else Object.defineProperty(HTMLImageElement.prototype, 'decode', decodeDescriptor);
  decode.mockClear();
  vi.restoreAllMocks();
});

/**
 * Pick a kind in the add media dialog's kind switch, as a mouse press does.
 * @param dialog - The dialog.
 * @param name - The kind's name.
 */
function chooseKind(dialog: HTMLElement, name: string): void {
  fireEvent.mouseDown(within(dialog).getByRole('tab', { name }));
}

describe('the toolbar (design §6.1, acceptance 12)', () => {
  const NAMES = ['添加素材', '添加网页动画', '添加文字', '撤销', '重做', '分割', '复制', '删除', '主轨磁吸', '自动吸附', '联动'];

  it('keeps every control on one row, as icon buttons named in order', async () => {
    seed([VIDEO]);
    show();
    const toolbar = await screen.findByRole('toolbar');
    expect(toolbar.className).not.toContain('flex-wrap');
    for (const element of toolbar.querySelectorAll('*')) expect(element.getAttribute('class') ?? '').not.toContain('flex-wrap');
    // More stays mounted but inert while every control fits, so it is not one the user can press.
    const buttons = within(toolbar).getAllByRole('button').filter((button) => button.closest('[inert]') === null);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(NAMES);
    for (const button of buttons) expect(button.textContent).toBe('');
    expect(within(toolbar).getByRole('slider', { name: '缩放' })).toBeInTheDocument();
  });

  it.each([
    ['timeline-split', '分割', formatShortcut({ mod: true, key: 'B' })],
    ['timeline-duplicate', '复制', formatShortcut({ mod: true, key: 'D' })],
    ['timeline-delete', '删除', formatShortcut({ key: 'Delete' })],
    ['timeline-toggle-snap', '自动吸附', 'N'],
  ])('names %s and its shortcut on hover', async (testId, name, shortcut) => {
    seed([VIDEO]);
    show();
    const user = userEvent.setup();
    await user.hover(await screen.findByTestId(testId));
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain(name);
    expect(tip.textContent).toContain(shortcut);
  });

  it.each([['timeline-add-media', '添加素材'], ['timeline-add-web-animation', '添加网页动画'], ['timeline-add-text', '添加文字'], ['timeline-toggle-magnet', '主轨磁吸'], ['timeline-toggle-linkage', '联动']])(
    'names %s on hover', async (testId, name) => {
      seed([VIDEO]);
      show();
      const user = userEvent.setup();
      await user.hover(await screen.findByTestId(testId));
      expect((await screen.findByRole('tooltip')).textContent).toContain(name);
    },
  );

  it('names the zoom slider on hover', async () => {
    seed([VIDEO]);
    show();
    const user = userEvent.setup();
    await user.hover(await screen.findByTestId('timeline-zoom'));
    expect((await screen.findByRole('tooltip')).textContent).toContain('缩放');
  });

  it('still names undo while it is disabled', async () => {
    seed([VIDEO]);
    show();
    const user = userEvent.setup();
    const undo = await screen.findByTestId('timeline-undo');
    expect(undo).toBeDisabled();
    const wrapper = undo.parentElement;
    if (wrapper === null) throw new Error('undo has no wrapper');
    await user.hover(wrapper);
    expect((await screen.findByRole('tooltip')).textContent).toContain('撤销');
  });

  it('shows a pressed switch as pressed', async () => {
    seed([VIDEO]);
    show();
    expect(await screen.findByTestId('timeline-toggle-snap')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('adding text (design §6.3, acceptance 1)', () => {
  it('places a default text clip at the playhead on the first free track above every drawn clip there, selects it and focuses its body', async () => {
    seed([VIDEO], undefined, ['v2']);
    show();
    await screen.findByTestId('timeline-clip-' + VIDEO.id);
    // The limits carry the text length and size the new clip takes.
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(`/projects/${PROJECT}/timeline-limits`, expect.anything()));
    seekForward(6);
    fireEvent.click(screen.getByTestId('timeline-add-text'));
    const added = await waitFor(() => {
      const found = Object.values(storedClips()).find((record) => record.kind === 'text');
      if (found === undefined) throw new Error('no text clip');
      return found;
    });
    expect(added).toMatchObject({ kind: 'text', trackId: 'v2', startFrame: 6, sourceInFrame: 0, durationFrames: 72, text: { body: '默认文字', size: 0.07 } });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('timeline-clip-text-body')));
    expect(screen.getByTestId('timeline-clip-' + String(added.id))).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('timeline-undo'));
    await waitFor(() => expect(Object.values(storedClips()).some((record) => record.kind === 'text')).toBe(false));
  });

  it('focuses the new text\'s body once: selecting it again later leaves the body unfocused, so the edit keys act on the clip', async () => {
    seed([VIDEO], undefined, ['v2']);
    show();
    await screen.findByTestId('timeline-clip-' + VIDEO.id);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(`/projects/${PROJECT}/timeline-limits`, expect.anything()));
    fireEvent.click(screen.getByTestId('timeline-add-text'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('timeline-clip-text-body')));
    const added = Object.values(storedClips()).find((record) => record.kind === 'text')!;
    const text = screen.getByTestId('timeline-clip-' + String(added.id));
    const video = screen.getByTestId('timeline-clip-' + VIDEO.id);
    fireEvent.click(video);
    await waitFor(() => expect(video).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(text);
    await waitFor(() => expect(text).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByTestId('timeline-clip-text-body')).not.toBe(document.activeElement);
  });

  it('puts the text on a new top track when the tracks above are busy at the playhead, moving and cutting nothing', async () => {
    seed([VIDEO, IMAGE], undefined, ['v2']);
    show();
    await screen.findByTestId('timeline-clip-' + IMAGE.id);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(`/projects/${PROJECT}/timeline-limits`, expect.anything()));
    fireEvent.click(screen.getByTestId('timeline-add-text'));
    await waitFor(() => expect(Object.values(storedClips()).some((record) => record.kind === 'text')).toBe(true));
    const tracks = currentDoc().getMap('tracks').toJSON() as Record<string, { id: string; order: number }>;
    const added = Object.values(storedClips()).find((record) => record.kind === 'text')!;
    expect(Object.keys(tracks)).toHaveLength(3);
    expect(tracks[String(added.trackId)]).toEqual({ id: added.trackId, order: 2 });
    expect(storedClips()[IMAGE.id]).toMatchObject({ trackId: 'v2', startFrame: 0, durationFrames: 72 });
    expect(storedClips()[VIDEO.id]).toMatchObject({ trackId: MAIN, startFrame: 0, durationFrames: 48 });
  });
});

describe('tracks and clip faces (design §3.1, §3.5, §6.4)', () => {
  it('names the tracks above the main track 轨道 N and offers 新建轨道', async () => {
    seed([VIDEO, IMAGE]);
    show();
    expect(within(await screen.findByTestId('timeline-track-v2')).getByText('轨道 2')).toBeInTheDocument();
    expect(within(screen.getByTestId('timeline-track-v3')).getByText('轨道 3')).toBeInTheDocument();
    const user = userEvent.setup();
    fireEvent.click(screen.getByTestId('timeline-clip-' + IMAGE.id));
    await user.click(screen.getByTestId('timeline-clip-track'));
    expect(await screen.findByRole('option', { name: '新建轨道' })).toBeInTheDocument();
  });

  it('shows a text clip by the first line of its body, a picture and a sound by their asset names, each with its length', async () => {
    seed([TEXT, { ...IMAGE, trackId: 'v3' }, { ...AUDIO, trackId: MAIN }]);
    show();
    const text = await screen.findByTestId('timeline-clip-' + TEXT.id);
    expect(text).toHaveAttribute('data-kind', 'text');
    expect(text).toHaveTextContent('镜头 1：开场');
    expect(text).not.toHaveTextContent('第二行');
    expect(text).toHaveTextContent('00:00:03:00');
    await waitFor(() => expect(screen.getByTestId('timeline-clip-' + IMAGE.id)).toHaveTextContent('镜头2-生成图.png'));
    expect(screen.getByTestId('timeline-clip-' + IMAGE.id)).toHaveAttribute('data-kind', 'image');
    await waitFor(() => expect(screen.getByTestId('timeline-clip-' + AUDIO.id)).toHaveTextContent('配乐-轻快.mp3'));
    expect(screen.getByTestId('timeline-clip-' + AUDIO.id)).toHaveAttribute('data-kind', 'audio');
  });

  it('colours picture and sound clips as the Canvas colours its picture and sound nodes, so the two kinds read apart', async () => {
    seed([IMAGE, AUDIO]);
    show();
    for (const [clip, kind] of [[IMAGE, 'image'], [AUDIO, 'audio']] as const) {
      expect((await screen.findByTestId('timeline-clip-' + clip.id)).className).toContain(`bg-[color:var(${NODE_TYPE_PALETTE[kind]}-bg)]`);
    }
  });

  it('names a selected text clip 文字 in its properties', async () => {
    seed([TEXT]);
    show();
    fireEvent.click(await screen.findByTestId('timeline-clip-' + TEXT.id));
    const panel = screen.getByTestId('timeline-side-panel');
    expect(within(panel).getByText('文字')).toBeInTheDocument();
    expect(within(panel).getByTestId('timeline-clip-text-body')).toHaveValue('镜头 1：开场\n第二行');
  });

  it('puts the clip kind icon of the track before the properties heading of every kind', async () => {
    seed([TEXT, IMAGE, AUDIO]);
    show();
    for (const [clip, icon] of [[TEXT, 'lucide-type'], [IMAGE, 'lucide-image'], [AUDIO, 'lucide-music']] as const) {
      const face = await screen.findByTestId('timeline-clip-' + clip.id);
      expect(face.querySelector(`svg.${icon}`)).not.toBeNull();
      fireEvent.click(face);
      const heading = within(screen.getByTestId('timeline-side-panel')).getByTestId('timeline-properties-heading');
      expect(heading.querySelector(`svg.${icon}`)).not.toBeNull();
    }
  });

  it('draws no record it cannot read, and of two clips overlapping on one track draws only the later-starting one', async () => {
    const DAMAGED = '30000000-0000-4000-8000-0000000000dd';
    const LATER = { ...IMAGE, id: '30000000-0000-4000-8000-000000000012', startFrame: 24 };
    const doc = seed([IMAGE, LATER]);
    doc.transact(() => {
      const damaged = new Y.Map<unknown>();
      doc.getMap('clips').set(DAMAGED, damaged);
      damaged.set('startFrame', 5);
    }, 'provider');
    show();
    await screen.findByTestId('timeline-clip-' + IMAGE.id);
    expect(screen.getByTestId('timeline-clip-' + LATER.id)).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-clip-' + DAMAGED)).toBe(null);
    expect(layerOf(DAMAGED)).toBe(null);
    seekForward(30);
    await waitFor(() => expect(layerOf(LATER.id)?.style.visibility).not.toBe('hidden'));
    expect(layerOf(IMAGE.id)).toBe(null);
  });

  it('neither draws nor plays a clip whose track was removed', async () => {
    const doc = seed([IMAGE, VIDEO]);
    show();
    await screen.findByTestId('timeline-clip-' + IMAGE.id);
    act(() => { doc.transact(() => doc.getMap('tracks').delete('v2'), 'provider'); });
    await waitFor(() => expect(screen.queryByTestId('timeline-clip-' + IMAGE.id)).toBe(null));
    expect(layerOf(IMAGE.id)).toBe(null);
  });
});

describe('the add media dialog (design §6.2, acceptance 2, 3)', () => {
  /**
   * Open the dialog from the toolbar.
   * @returns The dialog.
   */
  async function openDialog(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByTestId('timeline-add-media'));
    return screen.findByRole('dialog');
  }

  it('switches the kind in one segmented control beside the source buttons, the chosen kind selected (design §6.2)', async () => {
    seed([]);
    show();
    const dialog = await openDialog();
    const kinds = within(dialog).getByRole('tablist');
    expect(within(kinds).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['视频', '图片', '音频']);
    expect(within(kinds).getByRole('tab', { name: '视频' })).toHaveAttribute('aria-selected', 'true');
    chooseKind(dialog, '音频');
    expect(within(kinds).getByRole('tab', { name: '音频' })).toHaveAttribute('aria-selected', 'true');
    expect(within(kinds).getByRole('tab', { name: '视频' })).toHaveAttribute('aria-selected', 'false');
  });

  it('draws a sound or a coverless video in the same 64 by 40 place as a picture, so names start in one column (design §6.2)', async () => {
    seed([]);
    show();
    const dialog = await openDialog();
    chooseKind(dialog, '音频');
    const sound = await within(dialog).findByRole('button', { name: /配乐-轻快\.mp3/ });
    const tile = sound.firstElementChild!;
    expect(tile.tagName).toBe('SPAN');
    expect(tile).toHaveClass('h-10', 'w-16', 'bg-muted');
    expect(tile.querySelector('svg')).toHaveClass('size-4');
  });

  it('lines up the track and start frame fields in one column after the longer label (design §6.2)', async () => {
    seed([]);
    show();
    const dialog = await openDialog();
    const fields = within(dialog).getByTestId('timeline-material-track').closest('[data-material-fields]')!;
    expect(fields).toHaveClass('grid', 'grid-cols-[auto_minmax(0,1fr)]');
    expect(fields).toContainElement(within(dialog).getByTestId('timeline-start-frame'));
  });

  it('says 素材, lists Project pictures by kind with their size, and adds one for the configured picture length', async () => {
    magnetOff();
    seed([], undefined, ['v2']);
    show();
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(`/projects/${PROJECT}/timeline-limits`, expect.anything()));
    const dialog = await openDialog();
    expect(within(dialog).getByText('选择素材并确认添加位置。')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Project 素材' })).toBeInTheDocument();
    chooseKind(dialog, '图片');
    const choice = await within(dialog).findByRole('button', { name: /镜头2-生成图\.png/ });
    expect(choice).toHaveTextContent('1920 × 1080');
    expect(vi.mocked(apiGet).mock.calls.some(([url, config]) => url === `/projects/${PROJECT}/assets` && (config as { params?: { kind?: string } } | undefined)?.params?.kind === 'image')).toBe(true);
    fireEvent.click(choice);
    fireEvent.click(within(dialog).getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null));
    const added = Object.values(storedClips()).find((record) => record.kind === 'image');
    expect(added).toMatchObject({ kind: 'image', sourceInFrame: 0, durationFrames: 96 });
    const sources = currentDoc().getMap('sources').toJSON() as Record<string, Record<string, unknown>>;
    expect(sources[String(added?.sourceId)]).toEqual({
      id: added?.sourceId, kind: 'image', url: IMAGE_ASSET.fileUrl, name: IMAGE_ASSET.displayName, mimeType: 'image/png', width: 1920, height: 1080,
    });
  });

  it('draws each Project picture from its own file, since a registered picture has no cover (design §6.2)', async () => {
    seed([]);
    show();
    const dialog = await openDialog();
    chooseKind(dialog, '图片');
    const choice = await within(dialog).findByRole('button', { name: /镜头2-生成图\.png/ });
    expect(choice.querySelector('img')).toHaveAttribute('src', IMAGE_ASSET.fileUrl);
  });

  it('clears the chosen local file when the kind changes, so choosing the same file again is read', async () => {
    seed([]);
    show();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByTestId('timeline-material-local'));
    const user = userEvent.setup();
    await user.upload(within(dialog).getByTestId('timeline-file-input') as HTMLInputElement, new File(['mp4'], 'clip.mp4', { type: 'video/mp4' }));
    expect((within(dialog).getByTestId('timeline-file-input') as HTMLInputElement).files).toHaveLength(1);
    chooseKind(dialog, '图片');
    chooseKind(dialog, '视频');
    expect((within(dialog).getByTestId('timeline-file-input') as HTMLInputElement).files).toHaveLength(0);
  });

  it('lists Project sounds with their length and adds one for the length of its file', async () => {
    magnetOff();
    seed([], undefined, ['v2']);
    show();
    const dialog = await openDialog();
    chooseKind(dialog, '音频');
    const choice = await within(dialog).findByRole('button', { name: /配乐-轻快\.mp3/ });
    expect(choice).toHaveTextContent('14');
    fireEvent.click(choice);
    fireEvent.click(within(dialog).getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(Object.values(storedClips()).some((record) => record.kind === 'audio')).toBe(true));
    expect(Object.values(storedClips()).find((record) => record.kind === 'audio')).toMatchObject({ durationFrames: 336, gain: 1, mute: false });
  });

  it('offers every track and 新建轨道', async () => {
    seed([VIDEO]);
    show();
    const dialog = await openDialog();
    const user = userEvent.setup();
    await user.click(within(dialog).getByTestId('timeline-material-track'));
    for (const name of ['主轨', '轨道 2', '轨道 3', '新建轨道']) expect(await screen.findByRole('option', { name })).toBeInTheDocument();
  });

  it('chooses a local picture through 选择图片, places an image placeholder for the configured picture length and hands it off', async () => {
    magnetOff();
    seed([], undefined, ['v2']);
    show();
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(`/projects/${PROJECT}/timeline-limits`, expect.anything()));
    const dialog = await openDialog();
    chooseKind(dialog, '图片');
    fireEvent.click(within(dialog).getByTestId('timeline-material-local'));
    expect(within(dialog).getByRole('button', { name: '选择图片' })).toBeInTheDocument();
    const input = within(dialog).getByTestId('timeline-file-input');
    expect(input).toHaveAttribute('accept', 'image/*');
    const file = new File(['png'], '镜头1-分镜图.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(within(dialog).getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(handOffSpaceMedia).toHaveBeenCalledTimes(1));
    const placeholder = Object.values(storedClips()).find((record) => record.kind === 'upload');
    expect(placeholder).toMatchObject({ sourceInFrame: 0, durationFrames: 96, upload: { name: '镜头1-分镜图.png', kind: 'image', durationSeconds: null } });
    expect(vi.mocked(handOffSpaceMedia).mock.calls[0]?.[0]).toBe(file);
  });

  it('names a text clip before the insertion point by the first line of its body (design §6.2, §6.4)', async () => {
    seed([{ ...TEXT, trackId: MAIN, startFrame: 0, durationFrames: 48, text: { body: 'Opening\nline two', size: 0.06 } }]);
    show();
    await screen.findByTestId('timeline-clip-' + TEXT.id);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByTestId('timeline-start-frame'), { target: { value: '100' } });
    const hint = await within(dialog).findByTestId('timeline-material-insert-hint');
    expect(hint).toHaveTextContent('将插在 Opening 之后');
    expect(hint).not.toHaveTextContent('line two');
  });
});

/**
 * Turn the main-track magnet off for the signed-in editor before the Space renders.
 */
function magnetOff(): void {
  writeUserPreference(ME, { timelineMagnet: false });
}

describe('preview layers by kind (design §5.1, §5.3)', () => {
  it('draws a picture as an img decoded off the main thread from its file', async () => {
    seed([IMAGE]);
    show();
    await waitFor(() => expect(layerOf(IMAGE.id)?.localName).toBe('img'));
    const image = layerOf(IMAGE.id) as HTMLImageElement;
    expect(image.getAttribute('decoding')).toBe('async');
    expect(image.getAttribute('src')).toContain('https://cdn.example/image-2');
  });

  it('writes the body as text, never as markup, sized by the shown frame height, in the prefixed font stack', async () => {
    seed([{ ...TEXT, text: { body: '<b>粗</b> & 镜头', size: 0.06 } }]);
    show();
    const layer = await waitFor(() => {
      const found = layerOf(TEXT.id);
      if (found === null) throw new Error('no text layer');
      return found;
    });
    expect(layer.textContent).toBe('<b>粗</b> & 镜头');
    expect(layer.querySelector('b')).toBe(null);
    expect(layer.style.fontFamily).toContain('Breatic Timeline Inter');
    expect(layer.style.fontFamily).toContain('Breatic Timeline Noto Sans SC');
    expect(layer.style.whiteSpace).toBe('pre-wrap');
  });

  it('registers each slice it needs once, as a FontFace under the prefixed family with its glyph range', async () => {
    seed([TEXT]);
    show();
    await waitFor(() => expect(fontSet.add).toHaveBeenCalled());
    const families = FakeFontFace.made.map((face) => face.family);
    expect(families).toContain('Breatic Timeline Noto Sans SC');
    const sc = FakeFontFace.made.find((face) => face.family === 'Breatic Timeline Noto Sans SC');
    expect(sc?.source).toContain(`${fontBase}noto-sans-sc-han-wght-normal`);
    expect(sc?.unicodeRange.replace(/\s/g, '').toUpperCase()).toBe('U+4E00-9FFF,U+FF00-FFEF');
    expect(fetch).toHaveBeenCalledWith(`${fontBase}faces.json`, expect.anything());
  });

  it('shares one FontFace per slice between two open Timelines, and the one left stays ready after the other closes', async () => {
    seed([TEXT]);
    seed([{ ...TEXT, id: '30000000-0000-4000-8000-000000000044' }], undefined, ['v2', 'v3'], OTHER_SPACE);
    const client = newClient();
    const both = render(<>{body(client, SPACE)}{body(client, OTHER_SPACE)}</>);
    await waitFor(() => expect(fontSet.add).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const added = fontSet.add.mock.calls.map(([face]) => `${face.family}|${face.source}`);
    expect(new Set(added).size).toBe(added.length);
    both.rerender(<>{body(client, OTHER_SPACE)}</>);
    const remaining = screen.getByTestId('timeline-space');
    fireEvent.click(within(remaining).getByTestId('timeline-play'));
    await waitFor(() => expect(transport(remaining)).toBe('playing'));
  });
});

describe('the readiness barrier (design §5.4, §7.7)', () => {
  it('waits for a picture to decode before playing, then plays', async () => {
    decodeOutcome = 'pending';
    seed([IMAGE]);
    show();
    await waitFor(() => expect(layerOf(IMAGE.id)).not.toBe(null));
    fireEvent.click(screen.getByTestId('timeline-play'));
    await waitFor(() => expect(transport()).toBe('waiting'));
    await act(async () => { for (const resolve of pendingDecodes.splice(0)) resolve(); });
    await waitFor(() => expect(transport()).toBe('playing'));
  });

  it('waits for a text clip\'s slices to load before playing, then plays', async () => {
    fontOutcome = new Map([['noto-sans-sc-han-wght-normal', 'pending']]);
    seed([TEXT]);
    show();
    await waitFor(() => expect(pendingFonts.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId('timeline-play'));
    await waitFor(() => expect(transport()).toBe('waiting'));
    await act(async () => { for (const { resolve } of pendingFonts.splice(0)) resolve(); });
    await waitFor(() => expect(transport()).toBe('playing'));
  });

  it('loads a picture and a text that start within the premount lead before they show, so playing on through their start never waits (design §5.1, §5.3)', async () => {
    decodeOutcome = 'pending';
    fontOutcome = new Map([['noto-sans-sc-han-wght-normal', 'pending']]);
    const later = 24;
    // Long enough that playback cannot reach the Timeline end while the case watches it.
    seed([{ ...IMAGE, startFrame: later, durationFrames: 480 }, { ...TEXT, trackId: MAIN, startFrame: later, durationFrames: 480 }]);
    show();
    seekForward(later - 1);
    // Both load while the playhead is still before them: the picture's layer waits hidden and the text's slice loads.
    await waitFor(() => expect(pendingDecodes.length).toBeGreaterThan(0));
    await waitFor(() => expect(pendingFonts.length).toBeGreaterThan(0));
    expect(layerOf(IMAGE.id)?.style.visibility).toBe('hidden');
    await act(async () => {
      for (const resolve of pendingDecodes.splice(0)) resolve();
      for (const { resolve } of pendingFonts.splice(0)) resolve();
    });
    const states: string[] = [];
    const observer = new MutationObserver(() => { const state = transport(); if (state !== null && states.at(-1) !== state) states.push(state); });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-playback-state'] });
    fireEvent.click(screen.getByTestId('timeline-play'));
    await waitFor(() => expect(layerOf(IMAGE.id)?.style.visibility).not.toBe('hidden'), { timeout: 2000 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    observer.disconnect();
    expect(states).not.toContain('waiting');
    expect(transport()).toBe('playing');
  });

  it('waits for a sound with no data yet, as for a video', async () => {
    seed([AUDIO]);
    show();
    await waitFor(() => expect(mediaOf(AUDIO.id, 'audio')).toBeDefined());
    fireEvent.click(screen.getByTestId('timeline-play'));
    await waitFor(() => expect(transport()).toBe('waiting'));
  });

  it('plays on past a picture that cannot be decoded, notes it by track and retries only it', async () => {
    decodeOutcome = 'reject';
    seed([IMAGE]);
    show();
    const note = await screen.findByTestId('timeline-preview-note-' + IMAGE.id);
    expect(note).toHaveTextContent('轨道 2');
    expect(note).toHaveTextContent('图片读取失败');
    fireEvent.click(screen.getByTestId('timeline-play'));
    await waitFor(() => expect(transport()).toBe('playing'));
    decodeOutcome = 'resolve';
    const reads = decode.mock.calls.length;
    fireEvent.click(within(note).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(decode.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.queryByTestId('timeline-preview-note-' + IMAGE.id)).toBe(null));
  });

  it('plays on past a sound whose element failed and notes it by track', async () => {
    seed([AUDIO]);
    show();
    const element = await waitFor(() => {
      const found = mediaOf(AUDIO.id, 'audio');
      if (found === undefined) throw new Error('no audio element');
      return found;
    });
    Object.defineProperty(element, 'error', { configurable: true, value: { code: 2, message: 'network' } });
    act(() => { element.dispatchEvent(new Event('error')); });
    const note = await screen.findByTestId('timeline-preview-note-' + AUDIO.id);
    expect(note).toHaveTextContent('轨道 3');
    expect(note).toHaveTextContent('音频读取失败');
    fireEvent.click(screen.getByTestId('timeline-play'));
    await waitFor(() => expect(transport()).toBe('playing'));
  });

  it('draws a text clip in the fallback font, plays, and notes only in the preview when a slice fails (design §6.6)', async () => {
    fontOutcome = new Map([['noto-sans-sc-han-wght-normal', 'reject']]);
    seed([TEXT]);
    show();
    const note = await screen.findByTestId('timeline-preview-note-' + TEXT.id);
    expect(note).toHaveTextContent('轨道 2：文字字体加载失败');
    expect(layerOf(TEXT.id)?.textContent).toBe('镜头 1：开场\n第二行');
    expect(screen.getByTestId('timeline-clip-' + TEXT.id)).not.toHaveTextContent('字体');
    fireEvent.click(screen.getByTestId('timeline-play'));
    await waitFor(() => expect(transport()).toBe('playing'));
  });

  it('replaces a failed slice with a new FontFace on retry and clears the note in every open Timeline', async () => {
    fontOutcome = new Map([['noto-sans-sc-han-wght-normal', 'reject']]);
    seed([TEXT]);
    seed([{ ...TEXT, id: '30000000-0000-4000-8000-000000000044' }], undefined, ['v2', 'v3'], OTHER_SPACE);
    const client = newClient();
    render(<>{body(client, SPACE)}{body(client, OTHER_SPACE)}</>);
    const notes = await screen.findAllByText(/文字字体加载失败/);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    const failed = FakeFontFace.made.filter((face) => face.family === 'Breatic Timeline Noto Sans SC');
    expect(failed).toHaveLength(1);
    fontOutcome = new Map();
    fireEvent.click(within(screen.getByTestId('timeline-preview-note-' + TEXT.id)).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryAllByText(/文字字体加载失败/)).toHaveLength(0));
    const sc = FakeFontFace.made.filter((face) => face.family === 'Breatic Timeline Noto Sans SC');
    expect(sc).toHaveLength(2);
    expect(sc[1]?.unicodeRange).toBe(sc[0]?.unicodeRange);
    expect(sc[1]?.source).toBe(sc[0]?.source);
    expect(fontSet.faces.has(sc[1]!)).toBe(true);
    expect(fontSet.faces.has(sc[0]!)).toBe(false);
  });

  it.each([
    ['glyphs.json cannot be read', null],
    ['glyphs.json names a file faces.json does not', [{ file: 'inter-latin-wght-normal', glyphRange: 'U+0000-00FF' }, { file: 'noto-sans-sc-ghost', glyphRange: 'U+4E00-9FFF' }]],
    ['glyphs.json names a file twice', [{ file: 'inter-latin-wght-normal', glyphRange: 'U+0000-007F' }, { file: 'inter-latin-wght-normal', glyphRange: 'U+0080-00FF' }]],
    ['glyphs.json is not the expected shape', [{ file: 'inter-latin-wght-normal' }]],
  ])('treats the font data as unreadable when %s: the text draws, playback goes on, and the preview notes it', async (_case, stored) => {
    glyphs = stored;
    seed([TEXT]);
    show();
    expect(await screen.findByTestId('timeline-preview-note-' + TEXT.id)).toHaveTextContent('文字字体加载失败');
    expect(layerOf(TEXT.id)?.textContent).toBe('镜头 1：开场\n第二行');
    fireEvent.click(screen.getByTestId('timeline-play'));
    await waitFor(() => expect(transport()).toBe('playing'));
  });
});

describe('sound through Web Audio (design §5.2, §7.4, §7.5)', () => {
  it('makes no AudioContext before the first play, then one, resumed, with every lane through its own gain', async () => {
    seed([VIDEO, AUDIO]);
    show();
    await waitFor(() => expect(mediaOf(AUDIO.id, 'audio')).toBeDefined());
    expect(FakeAudioContext.made).toHaveLength(0);
    fireEvent.click(screen.getByTestId('timeline-play'));
    await waitFor(() => expect(FakeAudioContext.made).toHaveLength(1));
    const context = FakeAudioContext.made[0]!;
    expect(context.resume).toHaveBeenCalled();
    await waitFor(() => expect(context.sourceOf(AUDIO.id)?.mediaElement).toBe(mediaOf(AUDIO.id, 'audio')));
    expect(context.sourceOf(VIDEO.id)?.mediaElement).toBe(mediaOf(VIDEO.id, 'video'));
    expect(context.sourceOf(AUDIO.id)?.target()?.gain.value).toBe(2);
    expect(context.sourceOf(VIDEO.id)?.target()?.gain.value).toBe(0);
    expect(mediaOf(AUDIO.id, 'audio')?.volume).toBe(1);
    expect(mediaOf(AUDIO.id, 'audio')?.muted).toBe(false);
  });

  it('disconnects and releases a sound\'s lane when a collaborator deletes its clip', async () => {
    const doc = seed([AUDIO]);
    show();
    fireEvent.click(await screen.findByTestId('timeline-play'));
    await waitFor(() => expect(FakeAudioContext.made[0]?.sourceOf(AUDIO.id)).toBeDefined());
    const element = mediaOf(AUDIO.id, 'audio')!;
    const node = FakeAudioContext.made[0]!.sourceOf(AUDIO.id)!;
    act(() => { doc.transact(() => doc.getMap('clips').delete(AUDIO.id), 'provider'); });
    await waitFor(() => expect(node.disconnect).toHaveBeenCalled());
    expect(node.target()?.disconnect).toHaveBeenCalled();
    expect(element.getAttribute('src')).toBe(null);
    expect(element.isConnected).toBe(false);
  });

  it('closes the AudioContext when the Space tab is hidden and makes a new running one, wired to the lanes, on the next play', async () => {
    seed([AUDIO]);
    const { view, client } = show('visible');
    fireEvent.click(await screen.findByTestId('timeline-play'));
    await waitFor(() => expect(FakeAudioContext.made).toHaveLength(1));
    const first = FakeAudioContext.made[0]!;
    view.rerender(<React.Activity mode='hidden'>{body(client)}</React.Activity>);
    await waitFor(() => expect(first.close).toHaveBeenCalled());
    view.rerender(<React.Activity mode='visible'>{body(client)}</React.Activity>);
    const play = await screen.findByTestId('timeline-play');
    if (transport() !== 'paused') fireEvent.click(play);
    fireEvent.click(play);
    await waitFor(() => expect(FakeAudioContext.made).toHaveLength(2));
    const second = FakeAudioContext.made[1]!;
    await waitFor(() => expect(second.state).toBe('running'));
    await waitFor(() => expect(second.sourceOf(AUDIO.id)?.mediaElement).toBe(mediaOf(AUDIO.id, 'audio')));
  });
});

describe('media that cannot be read (design §6.6, acceptance 7)', () => {
  it('drops a picture\'s read failure with its layer once the playhead leaves, and reads the file again when it comes back (design §6.6, §7.4)', async () => {
    seed([{ ...VIDEO, durationFrames: 300 }, IMAGE]);
    decodeOutcome = 'reject';
    show();
    const clip = await screen.findByTestId('timeline-clip-' + IMAGE.id);
    await waitFor(() => expect(clip).toHaveTextContent('图片读取失败'));
    seekForward(200);
    await waitFor(() => expect(layerOf(IMAGE.id)).toBe(null));
    expect(clip).not.toHaveTextContent('读取失败');
    fireEvent.click(clip);
    expect(within(screen.getByTestId('timeline-side-panel')).queryByTestId('timeline-media-retry')).toBe(null);
    decodeOutcome = 'resolve';
    const reads = decode.mock.calls.length;
    const seek = screen.getAllByRole('slider')[0]!;
    seek.focus();
    for (let step = 0; step < 200; step += 1) fireEvent.keyDown(seek, { key: 'ArrowLeft' });
    await waitFor(() => expect(decode.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(layerOf(IMAGE.id)?.style.visibility).not.toBe('hidden'));
    expect(screen.getByTestId('timeline-clip-' + IMAGE.id)).not.toHaveTextContent('读取失败');
  });

  it('says a sound could not be read, on the clip, in its properties and in the preview, and retries only that layer', async () => {
    seed([AUDIO, IMAGE]);
    show();
    const sound = await waitFor(() => {
      const found = mediaOf(AUDIO.id, 'audio');
      if (found === undefined) throw new Error('no audio element');
      return found;
    });
    // A file stored by its address cannot be read only when its element fails (inner#2171).
    Object.defineProperty(sound, 'error', { configurable: true, value: { code: 2, message: 'network' } });
    act(() => { sound.dispatchEvent(new Event('error')); });
    const clip = await screen.findByTestId('timeline-clip-' + AUDIO.id);
    await waitFor(() => expect(clip).toHaveTextContent('音频读取失败'));
    const note = await screen.findByTestId('timeline-preview-note-' + AUDIO.id);
    expect(note).toHaveTextContent('轨道 3');
    expect(note).toHaveTextContent('音频读取失败');
    fireEvent.click(clip);
    const panel = screen.getByTestId('timeline-side-panel');
    expect(panel).toHaveTextContent('音频读取失败');
    expect(within(panel).getByTestId('timeline-media-retry')).toBeInTheDocument();
    const reload = vi.spyOn(sound, 'load').mockImplementation(() => undefined);
    const picture = layerOf(IMAGE.id);
    fireEvent.click(within(note).getByRole('button', { name: '重试' }));
    expect(reload).toHaveBeenCalledTimes(1);
    // The picture's layer is the same element, not loaded again.
    expect(layerOf(IMAGE.id)).toBe(picture);
    expect(picture).toHaveAttribute('src', IMAGE_ASSET.fileUrl);
  });
});

describe('upload placeholders (design §4.5, §7.1-§7.3)', () => {
  const UPLOAD = {
    ...PLACED, id: '30000000-0000-4000-8000-000000000009', kind: 'upload', trackId: 'v2', startFrame: 0, durationFrames: 36,
    upload: { uploadId: 'b0000000-0000-4000-8000-000000000001', name: '音效-转场.wav', kind: 'audio', durationSeconds: 1.5 },
  };

  it('shows 处理中 for a placeholder collab marked processing, on the clip and in the preview', async () => {
    seed([{ ...UPLOAD, upload: { ...UPLOAD.upload, state: 'processing' } }]);
    show();
    const clip = await screen.findByTestId('timeline-clip-' + UPLOAD.id);
    expect(clip).toHaveAttribute('data-state', 'processing');
    expect(clip).toHaveTextContent('处理中');
    expect(screen.getByTestId('timeline-preview-note-' + UPLOAD.id)).toHaveTextContent('处理中');
  });

  it('shows the reason collab wrote, in the Document\'s words, to every member', async () => {
    seed([{ ...UPLOAD, upload: { ...UPLOAD.upload, state: 'failed', failure: 'storageFull', retryable: false } }]);
    show();
    const clip = await screen.findByTestId('timeline-clip-' + UPLOAD.id);
    expect(clip).toHaveAttribute('data-state', 'failed');
    fireEvent.click(clip);
    expect(await screen.findByTestId('timeline-clip-upload')).toHaveTextContent('Studio 存储已满');
    expect(screen.queryByTestId('timeline-upload-retry')).toBe(null);
  });

  it('says what to do next for a placeholder nobody finishes', async () => {
    seed([UPLOAD]);
    show();
    const clip = await screen.findByTestId('timeline-clip-' + UPLOAD.id);
    expect(clip).toHaveAttribute('data-state', 'unfinished');
    fireEvent.click(clip);
    expect(screen.getByTestId('timeline-side-panel')).toHaveTextContent('删除后重新添加。');
  });

  it('reads the Project list of that kind again once collab lands this page\'s upload as a sound', async () => {
    magnetOff();
    seed([], undefined, ['v2']);
    const { client } = show();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByTestId('timeline-add-media'));
    const dialog = await screen.findByRole('dialog');
    chooseKind(dialog, '音频');
    fireEvent.click(within(dialog).getByTestId('timeline-material-local'));
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:local-audio'), revokeObjectURL: vi.fn() });
    vi.mocked(HTMLMediaElement.prototype.load).mockImplementation(function load(this: HTMLMediaElement) {
      if (this.getAttribute('src') !== 'blob:local-audio') return;
      Object.defineProperty(this, 'duration', { configurable: true, value: 1.5 });
      queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
    });
    fireEvent.change(within(dialog).getByTestId('timeline-file-input'), { target: { files: [new File(['wav'], '音效-转场.wav', { type: 'audio/wav' })] } });
    fireEvent.click(within(dialog).getByTestId('timeline-confirm-material'));
    await waitFor(() => expect(handOffSpaceMedia).toHaveBeenCalledTimes(1));
    const placeholder = Object.values(storedClips()).find((record) => record.kind === 'upload')!;
    expect(invalidate.mock.calls.some(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(timelineMediaQueryKey(PROJECT, 'audio')))).toBe(false);
    // Collab turns the placeholder into a sound clip under its own origin.
    const doc = currentDoc();
    act(() => {
      doc.transact(() => {
        doc.getMap('sources').set(AUDIO_SOURCE.id, AUDIO_SOURCE);
        const record = doc.getMap<Y.Map<unknown>>('clips').get(String(placeholder.id))!;
        record.set('kind', 'audio');
        record.set('sourceId', AUDIO_SOURCE.id);
        record.delete('upload');
      }, 'timeline-upload');
    });
    await waitFor(() => expect(invalidate.mock.calls.some(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(timelineMediaQueryKey(PROJECT, 'audio')))).toBe(true));
  });
});
