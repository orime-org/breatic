// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Web animation in the Timeline Space as users drive it (inner#1711 design §8, §9; #1490 design §8).
 *
 * The Timeline makes no web animations: "Add web animation" beside "Add media" places copies of the Project's
 * results, made in Motion Spaces (or in the Timeline before), and a copy's name, request and state come from the
 * resolution of its binding. A copy whose execution failed offers "Open in Motion". The preview shows a sandboxed player per visible copy in a fixed DOM order stacked by z-index, a note for copies
 * that are not ready, and a retry for one whose preview cannot load. Viewers see the list and its details only.
 *
 * The player itself and the page inside it run only in a real browser; here the player is an inert element and
 * only its attributes, identity and stacking are read.
 */

import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  t, type ProjectRegisteredAsset, type TimelineClip, type TimelineDocumentV1, type TimelineTrack,
  type TimelineVideoSource,
} from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { ApiException } from '@web/data/api/types';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import type { SocketState } from '@web/data/yjs/use-socket';
import { toast } from '@web/lib/toast';
import { writeUserPreference } from '@web/lib/user-preferences-storage';
import { useCurrentUserStore, useUIStore } from '@web/stores';
import { useSpaceOpenRequestStore } from '@web/stores/space-open-request';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useTimelineEditPrefsStore } from '@web/stores/timeline-edit-prefs';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';
import { gesture, moveableMock, resetMoveableMock } from '@web/spaces/timeline/__tests__/helpers/moveable-mock';
import { TimelineSpace } from '@web/spaces/timeline/TimelineSpace';
import { MAIN, clip as videoClip, seededDoc, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  EXEC_A, EXEC_FAILED, EXEC_RUNNING, MOTION_SPACE, RESOLUTION, SRC_A, SRC_B, boundTo, waitingFor, webClip,
} from '@web/data/yjs/__tests__/timeline-web-fixtures';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return {
    ...actual,
    timelineApi: {
      ...actual.timelineApi,
      listVideos: vi.fn(), resolveAsset: vi.fn(), limits: vi.fn(),
      listResults: vi.fn(), resolveWebSources: vi.fn(), previewUrl: vi.fn(),
    },
  };
});
// The player module as the preview loads it; a case sets `fail` to make the import reject.
const playerModule = vi.hoisted(() => ({ fail: false, imports: 0 }));
vi.mock('@hyperframes/player', () => {
  playerModule.imports += 1;
  if (playerModule.fail) throw new Error('Failed to fetch dynamically imported module');
  return {};
});
vi.mock('react-moveable', async () => (await import('@web/spaces/timeline/__tests__/helpers/moveable-mock')).moveableModule);
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const ME = 'user-timeline-editor';
const SETTINGS = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const ASSET: ProjectRegisteredAsset = {
  assetId: '20000000-0000-4000-8000-000000000001', projectReferenceId: '50000000-0000-4000-8000-000000000001',
  displayName: 'Product launch.mp4', kind: 'video', fileUrl: 'https://cdn.example/launch.mp4', coverUrl: null,
  width: 1280, height: 720, durationSeconds: 41.666, mimeType: 'video/mp4', sizeBytes: 8192,
};
const VIDEO_SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000001', kind: 'video', assetId: ASSET.assetId,
  timebase: SETTINGS.fps, extentFrames: 1000, durationSeconds: '41.666', durationOrigin: 'registered',
};
const PREVIEW_URL = 'https://preview.example/web-animation/token/index.html';
const LIMITS = {
  defaults: SETTINGS,
  assets: { pageSize: 50, pageMax: 100 },
  webAnimation: { promptMaxLength: 4000, durationSeconds: { min: 1, max: 60, default: 4 }, aspects: ['16:9', '9:16', '1:1'], playerLoadTimeoutMs: 15000, sourceRefreshIntervalMs: 10000 },
};
const CONNECTED: SocketState = {
  provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null,
};
const clients: QueryClient[] = [];

/**
 * The manager-owned document of this Space.
 * @returns It.
 * @throws {never} Never.
 */
function currentDoc(): Y.Doc {
  return getDoc(docName.timelineSpace(PROJECT, SPACE));
}

/**
 * Apply a server seed holding these tracks and clips through a real Yjs update.
 * @param clips - The clips.
 * @param tracks - The tracks.
 * @returns The client document.
 * @throws {Error} When the fixture is invalid.
 */
function seed(clips: TimelineClip[] = [], tracks: TimelineTrack[] = [track(MAIN, 0), track('v2', 1)]): Y.Doc {
  const server = seededDoc(timeline(clips, tracks, [VIDEO_SOURCE]));
  try {
    Y.applyUpdate(currentDoc(), Y.encodeStateAsUpdate(server), 'provider');
    return currentDoc();
  } finally { server.destroy(); }
}

/**
 * The current document.
 * @returns It.
 * @throws {Error} When its format is incompatible.
 */
function layout(): TimelineDocumentV1 {
  return readTimelineDocument(currentDoc());
}

/**
 * The web copies in the current document.
 * @returns Them.
 * @throws {Error} When its format is incompatible.
 */
function webCopies(): Array<Extract<TimelineClip, { kind: 'web-animation' }>> {
  return Object.values(layout().clips).filter((item): item is Extract<TimelineClip, { kind: 'web-animation' }> => item.kind === 'web-animation');
}

/**
 * Render the Timeline Space with this role.
 * @param readOnly - Whether the user is a Viewer.
 * @returns The query cache.
 * @throws {Error} When rendering fails.
 */
function showTimeline(readOnly = false): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={CONNECTED}>
    <div data-region='space'><TimelineSpace projectId={PROJECT} spaceId={SPACE} readOnly={readOnly} myRole={readOnly ? 'viewer' : 'editor'} /></div>
  </SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>);
  return client;
}

beforeEach(() => {
  _resetForTests();
  resetRunOnceForTests();
  resetMoveableMock();
  useSpaceOpenRequestStore.setState({ state: { status: 'none' } });
  window.localStorage.clear();
  useTimelineEditPrefsStore.setState({ owner: null });
  useCurrentUserStore.setState({ user: { id: ME, name: 'Me', email: 'me@e.com', personalStudio: { name: 'Me', slug: 'me', avatarUrl: null }, membershipTier: 'base' } });
  useUIStore.setState({ activeRegion: 'space' });
  writeUserPreference(ME, { timelineMagnet: false });
  for (const fn of Object.values(toast)) if (vi.isMockFunction(fn)) fn.mockClear();
  vi.mocked(timelineApi.listVideos).mockReset().mockResolvedValue({ items: [ASSET], nextCursor: null });
  vi.mocked(timelineApi.resolveAsset).mockReset().mockResolvedValue(ASSET);
  vi.mocked(timelineApi.limits).mockReset().mockResolvedValue(LIMITS as never);
  vi.mocked(timelineApi.listResults).mockReset().mockResolvedValue({ rows: [], nextCursor: null, totals: { done: 0, inProgress: 0 } });
  vi.mocked(timelineApi.resolveWebSources).mockReset().mockResolvedValue(RESOLUTION);
  vi.mocked(timelineApi.previewUrl).mockReset().mockResolvedValue({ url: PREVIEW_URL });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});

afterEach(() => {
  cleanup();
  clearAllDocSizes();
  useCurrentUserStore.setState({ user: null });
  for (const client of clients.splice(0)) client.clear();
  _resetForTests();
  resetRunOnceForTests();
  vi.restoreAllMocks();
});

describe('track toolbar', () => {
  it('offers an Editor Add web animation beside Add media, and no way to make one here', async () => {
    seed();
    showTimeline();
    expect(await screen.findByTestId('timeline-add-web-animation')).toHaveAccessibleName(t('timeline.webAnimation.add'));
    expect(screen.queryByTestId('timeline-create-web-animation')).toBeNull();
    expect(screen.queryByTestId('timeline-open-executions')).toBeNull();
  });

  it('shows a Viewer neither Add web animation nor an execution list', async () => {
    seed();
    showTimeline(true);
    await screen.findByTestId('timeline-side-panel');
    expect(screen.queryByTestId('timeline-add-web-animation')).toBeNull();
    expect(screen.queryByTestId('timeline-open-executions')).toBeNull();
  });
});

describe('preview of web copies', () => {
  it('mounts one sandboxed player for a visible copy that only the Timeline clock drives', async () => {
    seed([webClip('30000000-0000-4000-8000-000000000101', 'v2', 0, 48, boundTo(SRC_A))]);
    showTimeline();
    const preview = await screen.findByTestId('timeline-preview');
    await waitFor(() => expect(preview.querySelectorAll('hyperframes-player')).toHaveLength(1));
    const player = preview.querySelector('hyperframes-player') as HTMLElement;
    expect(player).toHaveAttribute('src', PREVIEW_URL);
    expect(player.hasAttribute('sandbox-origin')).toBe(true);
    expect(player.hasAttribute('disable-click-to-play')).toBe(true);
    expect(player.hasAttribute('controls')).toBe(false);
    expect(player.hasAttribute('autoplay')).toBe(false);
    expect(player.style.pointerEvents).toBe('none');
    expect(timelineApi.previewUrl).toHaveBeenCalledWith(PROJECT, SRC_A, expect.anything());
  });

  it('keys copies of one source by ordinal, stacks them by z-index and keeps the same elements when the stacking changes', async () => {
    const lower = '30000000-0000-4000-8000-000000000101';
    const upper = '30000000-0000-4000-8000-000000000102';
    seed([webClip(lower, 'v2', 0, 48, boundTo(SRC_A)), webClip(upper, 'v3', 0, 48, boundTo(SRC_A))], [track(MAIN, 0), track('v2', 1), track('v3', 2), track('v4', 3)]);
    showTimeline();
    const preview = await screen.findByTestId('timeline-preview');
    await waitFor(() => expect(preview.querySelectorAll('hyperframes-player')).toHaveLength(2));
    const before = [...preview.querySelectorAll<HTMLElement>('hyperframes-player')];
    expect(before.map((item) => item.dataset.instanceKey).sort()).toEqual([`${SRC_A}:0`, `${SRC_A}:1`]);
    const z = (clipId: string): number => Number(before.find((item) => item.dataset.clipId === clipId)?.style.zIndex);
    expect(z(upper)).toBeGreaterThan(z(lower));
    act(() => {
      const plan = applyTimelineEdit(currentDoc(), { operation: 'move', parameters: { clipId: lower, startFrame: 0, trackId: 'v4' }, placement: { magnet: false, linkage: false } }, 'peer', undefined, RESOLUTION);
      if (!plan.ok) throw new Error(plan.reason);
    });
    await waitFor(() => {
      const after = [...preview.querySelectorAll<HTMLElement>('hyperframes-player')];
      expect(after).toHaveLength(2);
      for (const item of after) expect(before).toContain(item);
      const zAfter = (clipId: string): number => Number(after.find((item) => item.dataset.clipId === clipId)?.style.zIndex);
      expect(zAfter(lower)).toBeGreaterThan(zAfter(upper));
    });
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(2);
  });

  it('mounts a player for a copy under a higher video, stacked below that video (breatic#1410 §6.1)', async () => {
    const copy = '30000000-0000-4000-8000-000000000101';
    const video = '30000000-0000-4000-8000-000000000201';
    seed([webClip(copy, 'v2', 0, 48, boundTo(SRC_A)), videoClip(video, 'v3', 0, 48, { sourceId: VIDEO_SOURCE.id })],
      [track(MAIN, 0), track('v2', 1), track('v3', 2)]);
    showTimeline();
    const preview = await screen.findByTestId('timeline-preview');
    const element = await waitFor(() => {
      const found = preview.querySelector<HTMLVideoElement>(`video[data-clip-id="${video}"]`);
      expect(found).not.toBeNull();
      return found as HTMLVideoElement;
    });
    const player = await waitFor(() => {
      const found = preview.querySelector<HTMLElement>(`hyperframes-player[data-clip-id="${copy}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(Number(player.style.zIndex)).toBeLessThan(Number(element.style.zIndex));
  });

  it('moves a web copy with the same preview handles as a video and writes its transform on release (breatic#1410 §4, item 10)', async () => {
    const copy = '30000000-0000-4000-8000-000000000109';
    seed([webClip(copy, 'v2', 0, 48, boundTo(SRC_A))]);
    // jsdom lays nothing out: the area the preview fits into measures 962 x 542 with the 1px border on each side, so the
    // frame and its layers measure 960 x 540, half the 1920 x 1080 canvas (breatic#1502 design §6.2).
    const parts = new Set(['timeline-preview', 'timeline-layer-overlay', 'timeline-layer-hit', 'timeline-preview-notes']);
    const rect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.testid === 'timeline-preview-area') return { x: 0, y: 0, left: 0, top: 0, right: 962, bottom: 542, width: 962, height: 542, toJSON: () => ({}) } as DOMRect;
      if (this instanceof HTMLElement && parts.has(this.dataset.testid ?? '')) return { x: 0, y: 0, left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540, toJSON: () => ({}) } as DOMRect;
      return rect.call(this);
    });
    showTimeline();
    fireEvent.click(await screen.findByTestId(`timeline-clip-${copy}`));
    await waitFor(() => expect(moveableMock.mounted).toBe(1));
    gesture.dragStart();
    const last = gesture.drag([30, -15]);
    expect(layout().clips[copy]?.transform).toEqual({ frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 });
    gesture.dragEnd(last);
    // 60 x -30 canvas pixels: 60 / 1920 and -30 / 1080 of the frame, rounded to 0.00001.
    await waitFor(() => expect(layout().clips[copy]?.transform).toEqual({ frameX: 0.03125, frameY: -0.02778, scaleX: 1, scaleY: 1, rotation: 0 }));
  });

  it('draws no picture for a placeholder and notes its status instead', async () => {
    const placeholder = '30000000-0000-4000-8000-000000000103';
    seed([webClip(placeholder, 'v2', 0, 48, waitingFor(EXEC_RUNNING))]);
    showTimeline();
    const note = await screen.findByTestId(`timeline-preview-note-${placeholder}`);
    // The sentence is chosen by the raw status, so each language words the whole note itself.
    expect(note).toHaveTextContent(t('timeline.webAnimation.preview.pending', { track: t('timeline.track', { index: 2 }), status: 'running' }));
    expect(note).toHaveTextContent('creating web animation');
    expect(screen.getByTestId('timeline-preview').querySelector('hyperframes-player')).toBeNull();
  });

  it('notes a copy whose execution failed with the whole sentence for that status', async () => {
    const failed = '30000000-0000-4000-8000-000000000108';
    seed([webClip(failed, 'v2', 0, 48, waitingFor(EXEC_FAILED))]);
    showTimeline();
    const note = await screen.findByTestId(`timeline-preview-note-${failed}`);
    await waitFor(() => expect(note).toHaveTextContent(t('timeline.webAnimation.preview.failed', { track: t('timeline.track', { index: 2 }), status: 'failed' })));
    expect(note).toHaveTextContent('web animation failed');
  });

  it('notes a copy whose preview address cannot be had and fetches a new one on retry', async () => {
    vi.mocked(timelineApi.previewUrl).mockRejectedValueOnce(new ApiException({ status: 404, message: 'Not found', fromServer: true }));
    const copy = '30000000-0000-4000-8000-000000000104';
    seed([webClip(copy, 'v2', 0, 48, boundTo(SRC_A))]);
    showTimeline();
    // The copy notes it is loading while its address is fetched, then that it is unavailable once the fetch fails.
    await waitFor(() => expect(screen.getByTestId(`timeline-preview-note-${copy}`))
      .toHaveTextContent(t('timeline.webAnimation.preview.unavailable', { track: t('timeline.track', { index: 2 }) })));
    const note = screen.getByTestId(`timeline-preview-note-${copy}`);
    await userEvent.click(within(note).getByTestId(`timeline-web-retry-${copy}`));
    await waitFor(() => expect(timelineApi.previewUrl).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('timeline-preview').querySelector('hyperframes-player')).not.toBeNull());
  });

  it('unloads an instance whose preview address was refused once its copy leaves, so a later copy of its source gets a new instance that asks again', async () => {
    // With idle instances kept, only the failure decides that the refused instance is unloaded rather than idled.
    vi.mocked(timelineApi.limits).mockResolvedValue({ ...LIMITS, webAnimation: { ...LIMITS.webAnimation, idleInstancesMax: 2 } } as never);
    vi.mocked(timelineApi.previewUrl).mockRejectedValueOnce(new ApiException({ status: 404, message: 'Not found', fromServer: true }));
    const first = '30000000-0000-4000-8000-000000000106';
    const later = '30000000-0000-4000-8000-000000000107';
    seed([webClip(first, 'v2', 0, 48, boundTo(SRC_A)), webClip(later, 'v2', 96, 48, boundTo(SRC_A))]);
    showTimeline();
    // Add web animation shows once the Timeline limits, and so the idle cap, have arrived.
    await screen.findByTestId('timeline-add-web-animation');
    const unavailable = t('timeline.webAnimation.preview.unavailable', { track: t('timeline.track', { index: 2 }) });
    await waitFor(() => expect(screen.getByTestId(`timeline-preview-note-${first}`)).toHaveTextContent(unavailable));
    const seek = screen.getByRole('slider', { name: t('timeline.seek') });
    // While its copy stays, the instance keeps its note and Retry and asks nothing more.
    fireEvent.keyDown(seek, { key: 'ArrowRight' });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId(`timeline-preview-note-${first}`)).toHaveTextContent(unavailable);
    expect(screen.getByTestId(`timeline-web-retry-${first}`)).toBeInTheDocument();
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(seek, { key: 'End' });
    const player = await waitFor(() => {
      const element = screen.getByTestId('timeline-preview').querySelector<HTMLElement>(`hyperframes-player[data-clip-id="${later}"]`);
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(player.dataset.instanceKey).toBe(`${SRC_A}:1`);
    expect(player).toHaveAttribute('src', PREVIEW_URL);
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId(`timeline-web-retry-${later}`)).toBeNull();
    expect(screen.queryByText(unavailable)).toBeNull();
  });
});

describe('play holds for a web copy that has just become visible', () => {
  const COPY = '30000000-0000-4000-8000-000000000105';
  // Each player's iframe window, recording what the host posts to it.
  let frames = new Map<Element, { frameWindow: Window; posted: ReturnType<typeof vi.fn> }>();

  beforeEach(() => {
    playerModule.fail = false;
    playerModule.imports = 0;
    frames = new Map();
    // Every player exposes the iframe its page runs in, as the real element does once defined.
    Object.defineProperty(HTMLElement.prototype, 'iframeElement', {
      configurable: true,
      get(this: HTMLElement): HTMLIFrameElement {
        const iframe = document.createElement('iframe');
        let frame = frames.get(this);
        if (frame === undefined) {
          const posted = vi.fn();
          frame = { frameWindow: { postMessage: posted } as unknown as Window, posted };
          frames.set(this, frame);
        }
        const { frameWindow } = frame;
        Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => frameWindow });
        return iframe;
      },
    });
  });

  afterEach(() => {
    // The document is shared across files; these stand-ins must not outlive the case.
    Reflect.deleteProperty(HTMLElement.prototype, 'iframeElement');
    Reflect.deleteProperty(HTMLIFrameElement.prototype, 'sandbox');
  });

  /**
   * Count the player element as defined, as it is once its module has loaded.
   * @throws {never} Never.
   */
  function playerDefined(): void {
    const get = customElements.get.bind(customElements);
    vi.spyOn(customElements, 'get').mockImplementation((name) => (name === 'hyperframes-player' ? HTMLElement : get(name)));
  }

  /**
   * Deliver a message from a player's page.
   * @param element - The player.
   * @param data - The message.
   * @throws {Error} When the host never reached that player.
   */
  function fromPage(element: Element, data: unknown): void {
    const frame = frames.get(element);
    if (frame === undefined) throw new Error('the host never reached this player');
    const event = new Event('message');
    Object.defineProperties(event, { data: { value: data }, source: { value: frame.frameWindow }, origin: { value: 'null' } });
    act(() => { window.dispatchEvent(event); });
  }

  /**
   * The play bar's playback state (breatic#1502 design §6.1): the row under the preview carries it as
   * `data-playback-state`, and only the waiting state also shows text, "Buffering…".
   * @returns The state.
   * @throws {Error} When the play bar carries no state.
   */
  function playbackState(): string | null {
    const row = screen.getByTestId('timeline-play').closest('[data-playback-state]');
    if (row === null) throw new Error('The play button is in no row with data-playback-state');
    return row.getAttribute('data-playback-state');
  }

  /**
   * Whether the play bar shows the buffering text. The text sits above the timecode, inside its wrapper and taken out of
   * the flow, so it never sits between the slider and the ratio control or moves anything in the row.
   * @returns True while it does.
   * @throws {Error} When the text is anywhere but above the timecode.
   */
  function buffering(): boolean {
    const label = screen.queryByText(t('timeline.transport.waiting'));
    if (label === null) return false;
    expect(screen.getByTestId('timeline-timecode').contains(label)).toBe(true);
    expect(label).toHaveClass('absolute', 'bottom-full', 'pointer-events-none', 'whitespace-nowrap');
    return true;
  }

  it('waits at the copy while its preview address is still being fetched, and plays once its page answers', async () => {
    playerDefined();
    let answer: (value: { url: string }) => void = () => {};
    vi.mocked(timelineApi.previewUrl).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    seed([webClip(COPY, 'v2', 0, 48, boundTo(SRC_A))]);
    showTimeline();
    await screen.findByTestId(`timeline-preview-note-${COPY}`);
    await waitFor(() => expect(timelineApi.previewUrl).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByTestId('timeline-play'));
    expect(playbackState()).toBe('waiting');
    expect(buffering()).toBe(true);

    await act(async () => { answer({ url: PREVIEW_URL }); });
    const player = await waitFor(() => {
      const element = screen.getByTestId('timeline-preview').querySelector('hyperframes-player');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    await waitFor(() => expect(frames.get(player)?.posted).toHaveBeenCalledWith({ type: 'breatic-hello' }, '*'));
    expect(playbackState()).toBe('waiting');
    expect(buffering()).toBe(true);

    fromPage(player, { type: 'breatic-bridge-ready' });
    const seek = frames.get(player)?.posted.mock.calls.map((call) => call[0] as { type?: string; session?: unknown; sequence?: unknown })
      .filter((message) => message.type === 'breatic-seek').at(-1);
    expect(seek).toBeDefined();
    expect(playbackState()).toBe('waiting');
    fromPage(player, { type: 'breatic-frame-ready', session: seek?.session, sequence: seek?.sequence });
    await waitFor(() => expect(playbackState()).toBe('playing'));
    expect(buffering()).toBe(false);
    expect(screen.queryByText('Playing')).toBeNull();
  });

  it('plays past a copy whose preview address was refused', async () => {
    playerDefined();
    vi.mocked(timelineApi.previewUrl).mockRejectedValue(new ApiException({ status: 404, message: 'Not found', fromServer: true }));
    seed([webClip(COPY, 'v2', 0, 48, boundTo(SRC_A))]);
    showTimeline();
    await waitFor(() => expect(screen.getByTestId(`timeline-preview-note-${COPY}`))
      .toHaveTextContent(t('timeline.webAnimation.preview.unavailable', { track: t('timeline.track', { index: 2 }) })));
    expect(playbackState()).toBe('paused');
    await userEvent.click(screen.getByTestId('timeline-play'));
    await waitFor(() => expect(playbackState()).toBe('playing'));
    expect(buffering()).toBe(false);
  });

  it('plays past a copy whose player module failed to load', async () => {
    Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', { configurable: true, get: () => document.createElement('div').classList });
    playerModule.fail = true;
    seed([webClip(COPY, 'v2', 0, 48, boundTo(SRC_A))]);
    showTimeline();
    await waitFor(() => expect(screen.getByTestId('timeline-preview').querySelector('hyperframes-player')).not.toBeNull());
    await waitFor(() => expect(playerModule.imports).toBe(1));
    await act(async () => { await Promise.resolve(); });
    await userEvent.click(screen.getByTestId('timeline-play'));
    await waitFor(() => expect(playbackState()).toBe('playing'));
    expect(buffering()).toBe(false);
  });
});

describe('web copies on the tracks and in properties', () => {
  it('marks copies by kind and by the state of what they show', async () => {
    const ready = '30000000-0000-4000-8000-000000000101';
    const waiting = '30000000-0000-4000-8000-000000000102';
    const failed = '30000000-0000-4000-8000-000000000103';
    seed([webClip(ready, 'v2', 0, 48, boundTo(SRC_A)), webClip(waiting, 'v2', 100, 48, waitingFor(EXEC_RUNNING)), webClip(failed, 'v2', 200, 48, waitingFor(EXEC_FAILED))]);
    showTimeline();
    await waitFor(() => expect(screen.getByTestId(`timeline-clip-${waiting}`)).toHaveAttribute('data-state', 'pending'));
    expect(screen.getByTestId(`timeline-clip-${ready}`)).toHaveAttribute('data-kind', 'web-animation');
    expect(screen.getByTestId(`timeline-clip-${ready}`)).toHaveAttribute('data-state', 'ready');
    expect(screen.getByTestId(`timeline-clip-${failed}`)).toHaveAttribute('data-state', 'failed');
  });

  it('names a copy by its whole request on the track and in its properties, from the resolution alone', async () => {
    const copy = '30000000-0000-4000-8000-000000000101';
    seed([webClip(copy, 'v2', 0, 48, boundTo(SRC_A))]);
    showTimeline();
    await waitFor(() => expect(screen.getByTestId(`timeline-clip-${copy}`)).toHaveTextContent('Gold dot along an arc'));
    await userEvent.click(screen.getByTestId(`timeline-clip-${copy}`));
    const panel = screen.getByTestId('timeline-side-panel');
    await waitFor(() => expect(panel).toHaveTextContent(t('timeline.webAnimation.copy')));
    expect(panel).toHaveTextContent('Gold dot along an arc');
    expect(within(panel).getByTestId('timeline-clip-start')).toBeInTheDocument();
    expect(within(panel).getByTestId('timeline-clip-duration')).toBeInTheDocument();
  });

  it('names a copy of a modification as modified from its base, and shows the base request in its properties', async () => {
    const copy = '30000000-0000-4000-8000-000000000104';
    seed([webClip(copy, 'v2', 0, 96, boundTo(SRC_B))]);
    showTimeline();
    const title = t('spaces.webAnimation.titleModifiedFrom', { base: 'Gold dot along an arc', request: 'Slower' });
    await waitFor(() => expect(screen.getByTestId(`timeline-clip-${copy}`)).toHaveTextContent(title));
    await userEvent.click(screen.getByTestId(`timeline-clip-${copy}`));
    const panel = screen.getByTestId('timeline-side-panel');
    await waitFor(() => expect(within(panel).getByTestId('timeline-web-base-request')).toHaveTextContent('Gold dot along an arc'));
    expect(panel).toHaveTextContent('Slower');
  });

  it('names a placeholder by the request of the execution it waits for', async () => {
    const waiting = '30000000-0000-4000-8000-000000000102';
    seed([webClip(waiting, 'v2', 0, 72, waitingFor(EXEC_RUNNING))]);
    showTimeline();
    await waitFor(() => expect(screen.getByTestId(`timeline-clip-${waiting}`)).toHaveTextContent('Brand name fades in'));
  });
});

describe('a copy whose execution failed', () => {
  const failed = '30000000-0000-4000-8000-000000000103';

  /**
   * List a Motion Space in the Project's meta document.
   */
  function withMotionSpace(): void {
    const entry = new Y.Map<unknown>();
    entry.set('id', MOTION_SPACE);
    entry.set('type', 'web_animation');
    entry.set('name', 'Motion');
    entry.set('createdAt', 1);
    getDoc(docName.projectMeta(PROJECT)).getMap('spaces').set(MOTION_SPACE, entry);
  }

  it('shows why it failed and offers Open in Motion, which asks for that Space with the execution selected', async () => {
    seed([webClip(failed, 'v2', 0, 48, waitingFor(EXEC_FAILED))]);
    showTimeline();
    await userEvent.click(await screen.findByTestId(`timeline-clip-${failed}`));
    const panel = screen.getByTestId('timeline-side-panel');
    await waitFor(() => expect(panel).toHaveTextContent(t('timeline.webAnimation.failure.stopped')));
    await userEvent.click(within(panel).getByTestId('timeline-web-open-in-motion'));
    expect(useSpaceOpenRequestStore.getState().state).toEqual({ status: 'requesting', request: { type: 'web_animation', spaceId: MOTION_SPACE, select: EXEC_FAILED } });
  });

  it('hides Open in Motion from a Viewer when the Project has no Motion Space, since a Viewer cannot make one', async () => {
    seed([webClip(failed, 'v2', 0, 48, waitingFor(EXEC_FAILED))]);
    showTimeline(true);
    await userEvent.click(await screen.findByTestId(`timeline-clip-${failed}`));
    await waitFor(() => expect(screen.getByTestId('timeline-side-panel')).toHaveTextContent(t('timeline.webAnimation.failure.stopped')));
    expect(screen.queryByTestId('timeline-web-open-in-motion')).toBeNull();
  });

  it('shows a Viewer Open in Motion when the Project has a Motion Space', async () => {
    withMotionSpace();
    seed([webClip(failed, 'v2', 0, 48, waitingFor(EXEC_FAILED))]);
    showTimeline(true);
    await userEvent.click(await screen.findByTestId(`timeline-clip-${failed}`));
    expect(await screen.findByTestId('timeline-web-open-in-motion')).toBeInTheDocument();
  });
});

describe('Add web animation', () => {
  const TIMELINE_SPACE = SPACE;

  /**
   * A result row as `GET /timeline/results` answers it.
   * @param id - The execution.
   * @param spaceId - The Space that made it.
   * @param request - Its request.
   * @param status - Its status.
   * @param resultSourceVersionId - What it made, when it succeeded.
   * @returns The row.
   */
  function result(id: string, spaceId: string, request: string, status: 'succeeded' | 'running', resultSourceVersionId: string | null): Record<string, unknown> {
    return {
      id, projectId: PROJECT, spaceId, actorUserId: ME, actionId: id, inputHash: 'sha256:x', attempt: 1, fence: null,
      billedCredits: null, billedAt: null, origin: spaceId === TIMELINE_SPACE ? 'timeline' : 'web_animation_space',
      status, phase: status === 'running' ? 'writing' : null, steps: [], failureReason: null, ownProject: true, usageCredits: 0,
      deadlineAt: '2026-11-15T10:00:00.000000Z', createdAt: '2026-11-15T08:00:00.000000Z', updatedAt: '2026-11-15T08:00:00.000000Z',
      kind: 'web_animation_create', engine: 'deepseek', request,
      input: { prompt: request, engine: 'deepseek', aspect: '16:9', durationSeconds: 2, fps: SETTINGS.fps },
      resultSourceVersionId, resultAssetId: null,
    };
  }

  /**
   * List Spaces in the Project's meta document.
   * @param spaces - Id, type and name of each.
   */
  function listSpaces(spaces: Array<[string, string, string]>): void {
    const map = getDoc(docName.projectMeta(PROJECT)).getMap('spaces');
    spaces.forEach(([id, type, name], index) => {
      const entry = new Y.Map<unknown>();
      entry.set('id', id);
      entry.set('type', type);
      entry.set('name', name);
      entry.set('createdAt', index + 1);
      map.set(id, entry);
    });
  }

  /**
   * Open the picker from the toolbar.
   * @returns The dialog.
   */
  async function openPicker(): Promise<HTMLElement> {
    await userEvent.click(await screen.findByTestId('timeline-add-web-animation'));
    return screen.findByTestId('timeline-web-animation-picker');
  }

  it('groups the Project\'s results by the Space that made them, Motion Spaces first and the Timeline last', async () => {
    const GONE = 'a0000000-0000-4000-8000-0000000000ee';
    listSpaces([[MOTION_SPACE, 'web_animation', 'Launch motion'], [TIMELINE_SPACE, 'timeline', 'Cut']]);
    vi.mocked(timelineApi.listResults).mockResolvedValue({
      rows: [result(EXEC_A, MOTION_SPACE, 'Gold dot along an arc', 'succeeded', SRC_A), result(EXEC_RUNNING, MOTION_SPACE, 'Brand name fades in', 'running', null),
        result('90000000-0000-4000-8000-0000000000c1', TIMELINE_SPACE, 'Old title card', 'succeeded', SRC_B), result('90000000-0000-4000-8000-0000000000c2', GONE, 'Lost one', 'succeeded', SRC_B)],
      nextCursor: null, totals: { done: 3, inProgress: 1 },
    } as never);
    seed();
    showTimeline();
    const picker = await openPicker();
    await waitFor(() => expect(within(picker).getAllByTestId(/^timeline-picker-group-/)).toHaveLength(3));
    expect(within(picker).getAllByTestId(/^timeline-picker-group-/).map((group) => group.getAttribute('data-testid'))).toEqual([
      `timeline-picker-group-${MOTION_SPACE}`, `timeline-picker-group-${TIMELINE_SPACE}`, 'timeline-picker-group-deleted',
    ]);
    expect(within(picker).getByTestId(`timeline-picker-group-${MOTION_SPACE}`)).toHaveTextContent('Launch motion');
    expect(within(picker).getByTestId('timeline-picker-group-deleted')).toHaveTextContent(t('timeline.webAnimation.picker.deletedSpace'));
    expect(within(picker).getByTestId(`timeline-picker-row-${EXEC_RUNNING}`)).toHaveTextContent(t('timeline.webAnimation.picker.making'));
    expect(within(picker).getByTestId(`timeline-picker-making-${EXEC_RUNNING}`)).toHaveTextContent(t('timeline.webAnimation.picker.making'));
    expect(within(picker).queryByTestId(`timeline-picker-making-${EXEC_A}`)).toBeNull();
  });

  it('places a finished result as a copy bound to its source, and a running one as a placeholder', async () => {
    listSpaces([[MOTION_SPACE, 'web_animation', 'Launch motion']]);
    vi.mocked(timelineApi.listResults).mockResolvedValue({
      rows: [result(EXEC_A, MOTION_SPACE, 'Gold dot along an arc', 'succeeded', SRC_A), result(EXEC_RUNNING, MOTION_SPACE, 'Brand name fades in', 'running', null)],
      nextCursor: null, totals: { done: 1, inProgress: 1 },
    } as never);
    seed();
    showTimeline();
    await userEvent.click(within(await openPicker()).getByTestId(`timeline-picker-row-${EXEC_A}`));
    await waitFor(() => expect(webCopies().map((copy) => copy.contentBinding)).toEqual([boundTo(SRC_A)]));
    await userEvent.click(within(await openPicker()).getByTestId(`timeline-picker-row-${EXEC_RUNNING}`));
    await waitFor(() => expect(webCopies().map((copy) => copy.contentBinding)).toEqual(expect.arrayContaining([boundTo(SRC_A), waitingFor(EXEC_RUNNING)])));
  });

  it('shows the empty state with Make in Motion, which asks for the newest Motion Space', async () => {
    seed();
    showTimeline();
    const picker = await openPicker();
    expect(await within(picker).findByText(t('timeline.webAnimation.picker.empty'))).toBeInTheDocument();
    await userEvent.click(within(picker).getByTestId('timeline-web-animation-go-make'));
    expect(useSpaceOpenRequestStore.getState().state).toEqual({ status: 'requesting', request: { type: 'web_animation' } });
  });

  it('closes the picker once the Motion Space opens, even when that Space handles the request at once', async () => {
    seed();
    showTimeline();
    await userEvent.click(within(await openPicker()).getByTestId('timeline-web-animation-go-make'));
    act(() => {
      const { dispatch } = useSpaceOpenRequestStore.getState();
      dispatch({ type: 'target_exists', spaceId: MOTION_SPACE });
      dispatch({ type: 'handled' });
    });
    await waitFor(() => expect(screen.queryByTestId('timeline-web-animation-picker')).toBeNull());
  });

  it('keeps the picker open when making the Motion Space fails', async () => {
    seed();
    showTimeline();
    const picker = await openPicker();
    await userEvent.click(within(picker).getByTestId('timeline-web-animation-go-make'));
    act(() => {
      const { dispatch } = useSpaceOpenRequestStore.getState();
      dispatch({ type: 'target_missing' });
      dispatch({ type: 'create_failed' });
    });
    expect(screen.getByTestId('timeline-web-animation-picker')).toBeInTheDocument();
    expect(within(picker).getByTestId('timeline-web-animation-go-make')).not.toHaveAttribute('aria-busy', 'true');
  });

  it('shows the error with a retry when the results cannot be read', async () => {
    vi.mocked(timelineApi.listResults).mockRejectedValueOnce(new ApiException({ status: 500, message: 'Boom', fromServer: true }));
    seed();
    showTimeline();
    const picker = await openPicker();
    await userEvent.click(await within(picker).findByTestId('timeline-web-animation-picker-retry'));
    await waitFor(() => expect(timelineApi.listResults).toHaveBeenCalledTimes(2));
  });

  it('waits on Retry with the list loading while it reads again', async () => {
    vi.mocked(timelineApi.listResults).mockRejectedValueOnce(new ApiException({ status: 500, message: 'Boom', fromServer: true })).mockReturnValueOnce(new Promise(() => {}));
    seed();
    showTimeline();
    const picker = await openPicker();
    expect(await within(picker).findByText(t('timeline.webAnimation.picker.error'))).toBeInTheDocument();
    await userEvent.click(within(picker).getByTestId('timeline-web-animation-picker-retry'));
    await waitFor(() => expect(within(picker).queryByText(t('timeline.webAnimation.picker.error'))).toBeNull());
    expect(picker.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0);
  });

  it('keeps the rows when Load more fails, and turns Load more into Retry', async () => {
    listSpaces([[MOTION_SPACE, 'web_animation', 'Launch motion']]);
    vi.mocked(timelineApi.listResults).mockImplementation(async (_projectId: string, cursor?: string) => {
      if (cursor !== undefined) throw new ApiException({ status: 500, message: 'Boom', fromServer: true });
      return { rows: [result(EXEC_A, MOTION_SPACE, 'Gold dot along an arc', 'succeeded', SRC_A)], nextCursor: 'next', totals: { done: 2, inProgress: 0 } } as never;
    });
    seed();
    showTimeline();
    const picker = await openPicker();
    await userEvent.click(await within(picker).findByRole('button', { name: t('timeline.webAnimation.picker.loadMore') }));
    expect(await within(picker).findByRole('button', { name: t('timeline.retry') })).toBeInTheDocument();
    expect(within(picker).getByTestId(`timeline-picker-row-${EXEC_A}`)).toBeInTheDocument();
    expect(within(picker).queryByText(t('timeline.webAnimation.picker.error'))).toBeNull();
  });

  it('keeps the empty state when a background read of the results fails', async () => {
    seed();
    const client = showTimeline();
    const picker = await openPicker();
    await within(picker).findByText(t('timeline.webAnimation.picker.empty'));
    vi.mocked(timelineApi.listResults).mockRejectedValue(new ApiException({ status: 500, message: 'Boom', fromServer: true }));
    // React Query tells its observers on a timer after the read settles.
    await act(async () => { await client.refetchQueries({ queryKey: ['timeline-web-results', PROJECT] }); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(client.getQueryState(['timeline-web-results', PROJECT])?.status).toBe('error');
    expect(within(picker).getByText(t('timeline.webAnimation.picker.empty'))).toBeInTheDocument();
    expect(within(picker).queryByText(t('timeline.webAnimation.picker.error'))).toBeNull();
  });
});

describe('web animation copy in every locale', () => {
  const KEYS = [
    'timeline.webAnimation.add', 'timeline.webAnimation.goMake', 'timeline.webAnimation.openInMotion', 'timeline.webAnimation.copy',
    'timeline.webAnimation.picker.title', 'timeline.webAnimation.picker.empty', 'timeline.webAnimation.picker.making',
    'timeline.webAnimation.picker.deletedSpace', 'timeline.webAnimation.picker.loadMore',
    'timeline.webAnimation.durationShort',
    'timeline.webAnimation.failure.feature_disabled', 'timeline.webAnimation.failure.unknown',
    'timeline.webAnimation.failure.check', 'timeline.webAnimation.failure.stopped',
    'timeline.webAnimation.preview.pending', 'timeline.webAnimation.preview.failed', 'timeline.webAnimation.preview.unavailable',
    'timeline.errors.source_unresolved',
  ];

  it.each(KEYS)('has %s in all five locales', (key) => {
    for (const [tag, catalog] of LOCALE_CATALOGS) {
      const sentence = readPath(catalog, key);
      expect(typeof sentence, `${tag} ${key}`).toBe('string');
      expect(String(sentence).trim(), `${tag} ${key}`).not.toBe('');
    }
  });

  it('names the track in the preview notes', () => {
    for (const key of ['timeline.webAnimation.preview.pending', 'timeline.webAnimation.preview.failed', 'timeline.webAnimation.preview.unavailable']) {
      for (const [tag, catalog] of LOCALE_CATALOGS) expect(String(readPath(catalog, key)), `${tag} ${key}`).toContain('{track}');
    }
  });

  it('writes the short duration as seconds with the unit of each language', () => {
    const expected: Record<string, string> = { en: '{seconds} s', 'zh-CN': '{seconds} 秒', 'zh-TW': '{seconds} 秒', ja: '{seconds} 秒', ko: '{seconds}초' };
    for (const [tag, catalog] of LOCALE_CATALOGS) expect(readPath(catalog, 'timeline.webAnimation.durationShort'), tag).toBe(expected[tag]);
  });

  it('has the agreed English sentences for failures and preview notes', () => {
    const english = LOCALE_CATALOGS[0]?.[1] ?? {};
    expect(readPath(english, 'timeline.webAnimation.failure.check')).toBe('The page did not pass the check.');
    expect(readPath(english, 'timeline.webAnimation.failure.stopped')).toBe('Creation stopped unexpectedly.');
    expect(readPath(english, 'timeline.webAnimation.preview.pending')).toBe(
      '{track}: {status, select, awaiting_landing {saving web animation} queued {web animation queued} running {creating web animation} cancelling {cancelling web animation} other {web animation pending}}…');
    expect(readPath(english, 'timeline.webAnimation.preview.failed')).toBe(
      '{track}: {status, select, failed {web animation failed} cancelled {web animation cancelled} expired {web animation expired} other {web animation not shown}}, not shown');
  });

  it('chooses the preview note sentence by status in every locale', () => {
    for (const key of ['timeline.webAnimation.preview.pending', 'timeline.webAnimation.preview.failed']) {
      for (const [tag, catalog] of LOCALE_CATALOGS) expect(String(readPath(catalog, key)), `${tag} ${key}`).toContain('{status, select,');
    }
  });

  it('keeps Timeline in English wherever a sentence names it', () => {
    for (const key of KEYS) {
      for (const [tag, catalog] of LOCALE_CATALOGS) {
        if (tag === 'en') continue;
        const english = String(readPath(LOCALE_CATALOGS[0]?.[1] ?? {}, key));
        if (english.includes('Timeline')) expect(String(readPath(catalog, key)), `${tag} ${key}`).toContain('Timeline');
      }
    }
  });
});
