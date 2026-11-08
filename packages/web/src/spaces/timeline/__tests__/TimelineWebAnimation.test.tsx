// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Web animation in the Timeline Space as users drive it (inner#1711 design §8, §9, V1, V2, V5, A8).
 *
 * The track toolbar opens the creation dialog and the execution list. Execute accepts the frozen input once
 * (`Idempotency-Key`), then lands the receipt, with a placeholder copy at the playhead when the switch is on. The
 * list has Completed and In Progress views; a row opens to its steps, usage and actions: cancel, add as placeholder,
 * add to the Timeline (repeatable, each a new copy) and run again (a prefilled dialog with a new action). The
 * preview shows a sandboxed player per visible copy in a fixed DOM order stacked by z-index, a note for copies
 * that are not ready, and a retry for one whose preview cannot load. Viewers see the list and its details only.
 *
 * The player itself and the page inside it run only in a real browser; here the player is an inert element and
 * only its attributes, identity and stacking are read.
 */

import * as React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  t, type ProjectRegisteredAsset, type TimelineClip, type TimelineDocumentV1, type TimelineExecution, type TimelineTrack,
  type TimelineVideoSource,
} from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { ApiException } from '@web/data/api/types';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import type { SocketState } from '@web/data/yjs/use-socket';
import { toast } from '@web/lib/toast';
import { writeUserPreference } from '@web/lib/user-preferences-storage';
import { useCurrentUserStore, useUIStore } from '@web/stores';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useTimelineEditPrefsStore } from '@web/stores/timeline-edit-prefs';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';
import { TimelineSpace } from '@web/spaces/timeline/TimelineSpace';
import { MAIN, clip as videoClip, seededDoc, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  EXEC_DONE, EXEC_FAILED, EXEC_RUNNING, RESOLUTION, SRC_A, SRC_B, boundTo, waitingFor, webClip,
} from '@web/data/yjs/__tests__/timeline-web-fixtures';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return {
    ...actual,
    timelineApi: {
      ...actual.timelineApi,
      listVideos: vi.fn(), resolveAsset: vi.fn(), limits: vi.fn(),
      listExecutions: vi.fn(), acceptExecution: vi.fn(), cancelExecution: vi.fn(), resolveWebSources: vi.fn(), previewUrl: vi.fn(),
    },
  };
});
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

/** A list row as `GET /timeline/executions` answers it. */
type ListedExecution = TimelineExecution & { usageCredits: number };

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
let rows: ListedExecution[] = [];

/**
 * A list row.
 * @param id - The execution id.
 * @param status - Its status.
 * @param fields - Overrides.
 * @returns The row.
 * @throws {never} Never.
 */
function row(id: string, status: TimelineExecution['status'], fields: Partial<ListedExecution> = {}): ListedExecution {
  return {
    id, projectId: PROJECT, spaceId: SPACE, actorUserId: ME, kind: 'web_animation_create',
    actionId: `a${id.slice(1)}`, input: { prompt: `Prompt of ${status}`, engine: 'deepseek', aspect: '16:9', durationSeconds: 3, fps: SETTINGS.fps },
    inputHash: `sha256:${status}`, engine: 'deepseek', status, phase: status === 'running' ? 'writing' : null, steps: [],
    attempt: 1, fence: null, deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    resultSourceVersionId: null, failureReason: null, billedCredits: null, billedAt: null,
    createdAt: '2026-11-07T08:00:00.000000Z', updatedAt: '2026-11-07T08:00:00.000000Z', usageCredits: 0, ...fields,
  };
}

const DONE_ROW = row(EXEC_DONE, 'succeeded', { resultSourceVersionId: SRC_B, usageCredits: 0.38, input: { prompt: 'Brand name fades in', engine: 'deepseek', aspect: '9:16', durationSeconds: 4, fps: SETTINGS.fps } });
const RUNNING_ROW = row(EXEC_RUNNING, 'running');
const FAILED_ROW = row(EXEC_FAILED, 'failed', { failureReason: 'feature_disabled', input: { prompt: 'A carousel of three products', engine: 'deepseek', aspect: '9:16', durationSeconds: 5, fps: SETTINGS.fps } });
const SOURCE_A_ROW = row('90000000-0000-4000-8000-0000000000a1', 'succeeded', { resultSourceVersionId: SRC_A, input: { prompt: 'Gold dot along an arc', engine: 'deepseek', aspect: '16:9', durationSeconds: 2, fps: SETTINGS.fps } });

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

/**
 * Open the execution list from the track toolbar.
 * @returns The list panel.
 * @throws {Error} When the control is missing.
 */
async function openList(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId('timeline-open-executions'));
  return screen.findByTestId('timeline-executions');
}

/**
 * Switch the list to one view.
 * @param name - The view's locale key.
 * @throws {Error} When the tab is missing.
 */
async function view(name: 'completed' | 'inProgress'): Promise<void> {
  const label = t(`timeline.webAnimation.list.${name}`);
  const tab = screen.getAllByRole('tab').find((item) => item.textContent?.includes(label));
  if (tab === undefined) throw new Error(`No ${name} tab`);
  await userEvent.click(tab);
}

/**
 * Open one row's details.
 * @param id - The execution.
 * @returns The details.
 * @throws {Error} When the row is missing.
 */
async function expand(id: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId(`timeline-execution-toggle-${id}`));
  return screen.findByTestId(`timeline-execution-detail-${id}`);
}

/**
 * Open the creation dialog from the toolbar.
 * @returns The dialog.
 * @throws {Error} When the control is missing.
 */
async function openCreate(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId('timeline-create-web-animation'));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  _resetForTests();
  resetRunOnceForTests();
  window.localStorage.clear();
  rows = [];
  useTimelineEditPrefsStore.setState({ owner: null });
  useCurrentUserStore.setState({ user: { id: ME, name: 'Me', email: 'me@e.com', personalStudio: { name: 'Me', slug: 'me', avatarUrl: null }, membershipTier: 'base' } });
  useUIStore.setState({ activeRegion: 'space' });
  writeUserPreference(ME, { timelineMagnet: false });
  for (const fn of Object.values(toast)) if (vi.isMockFunction(fn)) fn.mockClear();
  vi.mocked(timelineApi.listVideos).mockReset().mockResolvedValue({ items: [ASSET], nextCursor: null });
  vi.mocked(timelineApi.resolveAsset).mockReset().mockResolvedValue(ASSET);
  vi.mocked(timelineApi.limits).mockReset().mockResolvedValue(LIMITS as never);
  vi.mocked(timelineApi.listExecutions).mockReset().mockImplementation(async () => rows);
  vi.mocked(timelineApi.acceptExecution).mockReset();
  vi.mocked(timelineApi.cancelExecution).mockReset();
  vi.mocked(timelineApi.resolveWebSources).mockReset().mockResolvedValue(RESOLUTION);
  vi.mocked(timelineApi.previewUrl).mockReset().mockResolvedValue({ url: PREVIEW_URL });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});

afterEach(() => {
  cleanup();
  useCurrentUserStore.setState({ user: null });
  for (const client of clients.splice(0)) client.clear();
  _resetForTests();
  resetRunOnceForTests();
  vi.restoreAllMocks();
});

describe('track toolbar', () => {
  it('offers an Editor the creation dialog and the execution list beside Add media', async () => {
    seed();
    showTimeline();
    expect(await screen.findByTestId('timeline-create-web-animation')).toHaveTextContent(t('timeline.webAnimation.create'));
    expect(screen.getByTestId('timeline-open-executions')).toHaveTextContent(t('timeline.webAnimation.executions'));
  });

  it('shows a Viewer the execution list but not the creation control', async () => {
    seed();
    showTimeline(true);
    expect(await screen.findByTestId('timeline-open-executions')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-create-web-animation')).toBeNull();
  });
});

describe('creation dialog', () => {
  it('opens with the default duration and the first aspect the Timeline limits give', async () => {
    seed();
    showTimeline();
    const dialog = await openCreate();
    expect(within(dialog).getByTestId('web-animation-duration')).toHaveValue(4);
    expect(within(dialog).getByTestId('web-animation-aspect')).toHaveTextContent('16:9');
  });

  it('accepts the frozen input once with the document fps, lands the receipt with a placeholder at the playhead and shows the run', async () => {
    seed();
    showTimeline();
    const dialog = await openCreate();
    expect(within(dialog).getByText(t('timeline.webAnimation.dialog.title'))).toBeInTheDocument();
    await userEvent.type(within(dialog).getByTestId('web-animation-prompt'), 'A blue title slides in');
    const duration = within(dialog).getByTestId('web-animation-duration');
    await userEvent.clear(duration);
    await userEvent.type(duration, '6');
    expect(within(dialog).getByTestId('web-animation-add-at-playhead')).toHaveAttribute('aria-checked', 'true');
    const accepted = row('90000000-0000-4000-8000-0000000000b1', 'awaiting_landing', { inputHash: 'sha256:frozen' });
    vi.mocked(timelineApi.acceptExecution).mockImplementation(async (body) => {
      rows = [{ ...accepted, actionId: body.actionId }];
      return { ...accepted, actionId: body.actionId };
    });
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));

    await waitFor(() => expect(timelineApi.acceptExecution).toHaveBeenCalledTimes(1));
    const [body, key] = vi.mocked(timelineApi.acceptExecution).mock.calls[0] ?? [];
    expect(body).toEqual({
      projectId: PROJECT, spaceId: SPACE, actionId: expect.stringMatching(/^[0-9a-f-]{36}$/), prompt: 'A blue title slides in',
      engine: 'deepseek', aspect: '16:9', durationSeconds: 6, fps: SETTINGS.fps,
    });
    expect(key).toEqual(expect.any(String));
    const actionId = body?.actionId ?? '';
    await waitFor(() => expect(layout().operationReceipts[actionId]).toMatchObject({ executionId: accepted.id, inputHash: 'sha256:frozen' }));
    expect(new Date(layout().operationReceipts[actionId]?.landedAt ?? '').toString()).not.toBe('Invalid Date');
    expect(webCopies()).toEqual([expect.objectContaining({ startFrame: 0, sourceInFrame: 0, durationFrames: 144, contentBinding: waitingFor(accepted.id) })]);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const list = await screen.findByTestId('timeline-executions');
    const inProgress = within(list).getAllByRole('tab').find((item) => item.textContent?.includes(t('timeline.webAnimation.list.inProgress')));
    expect(inProgress).toHaveAttribute('aria-selected', 'true');
    expect(await within(list).findByTestId(`timeline-execution-${accepted.id}`)).toHaveAttribute('data-status', 'awaiting_landing');
  });

  it('lands only the receipt when the add-at-playhead switch is off', async () => {
    seed();
    showTimeline();
    const dialog = await openCreate();
    await userEvent.type(within(dialog).getByTestId('web-animation-prompt'), 'Title');
    await userEvent.click(within(dialog).getByTestId('web-animation-add-at-playhead'));
    const accepted = row('90000000-0000-4000-8000-0000000000b2', 'awaiting_landing');
    vi.mocked(timelineApi.acceptExecution).mockImplementation(async (body) => ({ ...accepted, actionId: body.actionId }));
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));
    await waitFor(() => expect(Object.values(layout().operationReceipts)).toEqual([expect.objectContaining({ executionId: accepted.id })]));
    expect(webCopies()).toEqual([]);
  });

  it('shows the Execute button loading while the accept is out', async () => {
    seed();
    showTimeline();
    const dialog = await openCreate();
    await userEvent.type(within(dialog).getByTestId('web-animation-prompt'), 'Title');
    vi.mocked(timelineApi.acceptExecution).mockReturnValue(new Promise(() => {}));
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));
    expect(within(dialog).getByTestId('web-animation-execute')).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));
    expect(timelineApi.acceptExecution).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog and the input and shows the reason when the accept is refused for credits', async () => {
    seed();
    showTimeline();
    const dialog = await openCreate();
    await userEvent.type(within(dialog).getByTestId('web-animation-prompt'), 'Spring sale title');
    vi.mocked(timelineApi.acceptExecution).mockRejectedValue(new ApiException({ status: 402, message: 'Your Studio has no credits left.', fromServer: true }));
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your Studio has no credits left.');
    expect(within(dialog).getByTestId('web-animation-prompt')).toHaveValue('Spring sale title');
    expect(layout().operationReceipts).toEqual({});
    expect(webCopies()).toEqual([]);
  });
});

describe('execution list', () => {
  beforeEach(() => {
    rows = [RUNNING_ROW, DONE_ROW, FAILED_ROW, row('90000000-0000-4000-8000-0000000000c1', 'cancelled'), row('90000000-0000-4000-8000-0000000000c2', 'awaiting_landing')];
  });

  it('splits rows into In Progress and Completed', async () => {
    seed();
    showTimeline();
    const list = await openList();
    await view('inProgress');
    const active = await within(list).findAllByTestId(/^timeline-execution-[0-9a-f-]{36}$/);
    expect(active.map((item) => item.getAttribute('data-status')).sort()).toEqual(['awaiting_landing', 'running']);
    await view('completed');
    const done = await within(list).findAllByTestId(/^timeline-execution-[0-9a-f-]{36}$/);
    expect(done.map((item) => item.getAttribute('data-status')).sort()).toEqual(['cancelled', 'failed', 'succeeded']);
  });

  it('shows the empty state of a view with no rows', async () => {
    rows = [DONE_ROW];
    seed();
    showTimeline();
    await openList();
    await view('inProgress');
    expect(await screen.findByText(t('timeline.webAnimation.list.emptyInProgress'))).toBeInTheDocument();
  });

  it('shows a running row status and phase, and its steps and cancel in the details', async () => {
    seed();
    showTimeline();
    await openList();
    await view('inProgress');
    expect(await screen.findByTestId(`timeline-execution-${EXEC_RUNNING}`)).toHaveTextContent(t('timeline.webAnimation.status.running'));
    const detail = await expand(EXEC_RUNNING);
    expect(detail).toHaveTextContent(t('timeline.webAnimation.phase.writing'));
    vi.mocked(timelineApi.cancelExecution).mockImplementation(async () => {
      rows = rows.map((item) => (item.id === EXEC_RUNNING ? { ...item, status: 'cancelling' } : item));
      return { ...RUNNING_ROW, status: 'cancelling' };
    });
    const calls = vi.mocked(timelineApi.listExecutions).mock.calls.length;
    await userEvent.click(within(detail).getByTestId(`timeline-execution-cancel-${EXEC_RUNNING}`));
    expect(timelineApi.cancelExecution).toHaveBeenCalledWith(EXEC_RUNNING, expect.any(String));
    await waitFor(() => expect(vi.mocked(timelineApi.listExecutions).mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(screen.getByTestId(`timeline-execution-${EXEC_RUNNING}`)).toHaveAttribute('data-status', 'cancelling'));
  });

  it('adds a running execution as a placeholder copy at the playhead', async () => {
    seed();
    showTimeline();
    await openList();
    await view('inProgress');
    const detail = await expand(EXEC_RUNNING);
    await userEvent.click(within(detail).getByTestId(`timeline-execution-add-placeholder-${EXEC_RUNNING}`));
    await waitFor(() => expect(webCopies()).toEqual([expect.objectContaining({ startFrame: 0, durationFrames: 72, contentBinding: waitingFor(EXEC_RUNNING) })]));
  });

  it('adds a succeeded result again and again, each a new copy bound to the same source', async () => {
    seed();
    showTimeline();
    await openList();
    await view('completed');
    const detail = await expand(EXEC_DONE);
    expect(detail).toHaveTextContent('0.38');
    await userEvent.click(within(detail).getByTestId(`timeline-execution-add-${EXEC_DONE}`));
    await userEvent.click(within(detail).getByTestId(`timeline-execution-add-${EXEC_DONE}`));
    await waitFor(() => expect(webCopies()).toHaveLength(2));
    const [first, second] = webCopies();
    expect(first?.id).not.toBe(second?.id);
    for (const copy of webCopies()) expect(copy).toMatchObject({ startFrame: 0, durationFrames: 96, contentBinding: boundTo(SRC_B) });
    expect(first?.trackId).not.toBe(second?.trackId);
  });

  it('shows the feature-off reason for a failed run and runs it again from a prefilled dialog under a new action', async () => {
    seed();
    showTimeline();
    await openList();
    await view('completed');
    const detail = await expand(EXEC_FAILED);
    expect(detail).toHaveTextContent(t('timeline.webAnimation.failure.feature_disabled'));
    await userEvent.click(within(detail).getByTestId(`timeline-execution-retry-${EXEC_FAILED}`));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t('timeline.webAnimation.dialog.retryTitle'))).toBeInTheDocument();
    expect(within(dialog).getByTestId('web-animation-prompt')).toHaveValue('A carousel of three products');
    expect(within(dialog).getByTestId('web-animation-duration')).toHaveValue(5);
    expect(within(dialog).getByTestId('web-animation-aspect')).toHaveTextContent('9:16');
    vi.mocked(timelineApi.acceptExecution).mockImplementation(async (body) => ({ ...row('90000000-0000-4000-8000-0000000000d1', 'awaiting_landing'), actionId: body.actionId }));
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));
    await waitFor(() => expect(timelineApi.acceptExecution).toHaveBeenCalledTimes(1));
    const body = vi.mocked(timelineApi.acceptExecution).mock.calls[0]?.[0];
    expect(body).toMatchObject({ prompt: 'A carousel of three products', aspect: '9:16', durationSeconds: 5 });
    expect(body?.actionId).not.toBe(FAILED_ROW.actionId);
  });

  it('shows a general reason for a failure it has no sentence for', async () => {
    rows = [row(EXEC_FAILED, 'failed', { failureReason: 'validation_failed' })];
    seed();
    showTimeline();
    await openList();
    await view('completed');
    expect(await expand(EXEC_FAILED)).toHaveTextContent(t('timeline.webAnimation.failure.unknown'));
  });

  it('lets a Viewer open rows and read their details but offers no action', async () => {
    seed();
    showTimeline(true);
    await openList();
    await view('completed');
    const done = await expand(EXEC_DONE);
    expect(within(done).queryByTestId(`timeline-execution-add-${EXEC_DONE}`)).toBeNull();
    const failed = await expand(EXEC_FAILED);
    expect(within(failed).queryByTestId(`timeline-execution-retry-${EXEC_FAILED}`)).toBeNull();
    await view('inProgress');
    const running = await expand(EXEC_RUNNING);
    expect(running).toHaveTextContent(t('timeline.webAnimation.phase.writing'));
    expect(within(running).queryByTestId(`timeline-execution-cancel-${EXEC_RUNNING}`)).toBeNull();
    expect(within(running).queryByTestId(`timeline-execution-add-placeholder-${EXEC_RUNNING}`)).toBeNull();
  });
});

describe('landing after a reopen', () => {
  const pending = row('90000000-0000-4000-8000-0000000000e1', 'awaiting_landing', { inputHash: 'sha256:pending' });

  it('writes the receipt of an accepted action whose landing never happened', async () => {
    rows = [pending];
    seed();
    showTimeline();
    await waitFor(() => expect(layout().operationReceipts[pending.actionId]).toMatchObject({ executionId: pending.id, inputHash: 'sha256:pending' }));
  });

  it('leaves it alone for a Viewer and after its deadline', async () => {
    rows = [pending, { ...pending, id: '90000000-0000-4000-8000-0000000000e2', actionId: 'a0000000-0000-4000-8000-0000000000e2', deadlineAt: new Date(Date.now() - 1000).toISOString() }];
    seed();
    showTimeline(true);
    await waitFor(() => expect(timelineApi.listExecutions).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(layout().operationReceipts).toEqual({});
    cleanup();
    showTimeline();
    await waitFor(() => expect(Object.keys(layout().operationReceipts)).toEqual([pending.actionId]));
  });
});

describe('preview of web copies', () => {
  it('mounts one sandboxed player for a visible copy that only the Timeline clock drives', async () => {
    rows = [SOURCE_A_ROW];
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
    rows = [SOURCE_A_ROW];
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

  it('mounts no player for a copy under a higher video', async () => {
    rows = [SOURCE_A_ROW];
    seed([webClip('30000000-0000-4000-8000-000000000101', 'v2', 0, 48, boundTo(SRC_A)), videoClip('30000000-0000-4000-8000-000000000201', 'v3', 0, 48, { sourceId: VIDEO_SOURCE.id })],
      [track(MAIN, 0), track('v2', 1), track('v3', 2)]);
    showTimeline();
    const preview = await screen.findByTestId('timeline-preview');
    await waitFor(() => expect(preview.querySelector('video')).not.toBeNull());
    expect(preview.querySelector('hyperframes-player')).toBeNull();
  });

  it('draws no picture for a placeholder and notes its status instead', async () => {
    rows = [RUNNING_ROW];
    const placeholder = '30000000-0000-4000-8000-000000000103';
    seed([webClip(placeholder, 'v2', 0, 48, waitingFor(EXEC_RUNNING))]);
    showTimeline();
    const note = await screen.findByTestId(`timeline-web-note-${placeholder}`);
    expect(note).toHaveTextContent(t('timeline.webAnimation.preview.pending', { track: t('timeline.track', { index: 2 }), status: t('timeline.webAnimation.status.running') }));
    expect(screen.getByTestId('timeline-preview').querySelector('hyperframes-player')).toBeNull();
  });

  it('notes a copy whose preview address cannot be had and fetches a new one on retry', async () => {
    rows = [SOURCE_A_ROW];
    vi.mocked(timelineApi.previewUrl).mockRejectedValueOnce(new ApiException({ status: 404, message: 'Not found', fromServer: true }));
    const copy = '30000000-0000-4000-8000-000000000104';
    seed([webClip(copy, 'v2', 0, 48, boundTo(SRC_A))]);
    showTimeline();
    // The copy notes it is loading while its address is fetched, then that it is unavailable once the fetch fails.
    await waitFor(() => expect(screen.getByTestId(`timeline-web-note-${copy}`))
      .toHaveTextContent(t('timeline.webAnimation.preview.unavailable', { track: t('timeline.track', { index: 2 }) })));
    const note = screen.getByTestId(`timeline-web-note-${copy}`);
    await userEvent.click(within(note).getByTestId(`timeline-web-retry-${copy}`));
    await waitFor(() => expect(timelineApi.previewUrl).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('timeline-preview').querySelector('hyperframes-player')).not.toBeNull());
  });
});

describe('web copies on the tracks and in properties', () => {
  it('marks copies by kind and by the state of what they show', async () => {
    rows = [SOURCE_A_ROW, RUNNING_ROW, FAILED_ROW];
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

  it('names a selected copy and the request it came from', async () => {
    rows = [SOURCE_A_ROW];
    const copy = '30000000-0000-4000-8000-000000000101';
    seed([webClip(copy, 'v2', 0, 48, boundTo(SRC_A))]);
    showTimeline();
    await userEvent.click(await screen.findByTestId(`timeline-clip-${copy}`));
    const panel = screen.getByTestId('timeline-side-panel');
    await waitFor(() => expect(panel).toHaveTextContent(t('timeline.webAnimation.copy')));
    expect(panel).toHaveTextContent('Gold dot along an arc');
    expect(within(panel).getByTestId('timeline-clip-start')).toBeInTheDocument();
    expect(within(panel).getByTestId('timeline-clip-duration')).toBeInTheDocument();
  });
});

describe('web animation copy in every locale', () => {
  const KEYS = [
    'timeline.webAnimation.create', 'timeline.webAnimation.executions', 'timeline.webAnimation.copy',
    'timeline.webAnimation.dialog.title', 'timeline.webAnimation.dialog.retryTitle', 'timeline.webAnimation.dialog.prompt',
    'timeline.webAnimation.dialog.engine', 'timeline.webAnimation.dialog.aspect', 'timeline.webAnimation.dialog.duration',
    'timeline.webAnimation.dialog.addAtPlayhead', 'timeline.webAnimation.dialog.execute',
    'timeline.webAnimation.list.completed', 'timeline.webAnimation.list.inProgress',
    'timeline.webAnimation.list.emptyCompleted', 'timeline.webAnimation.list.emptyInProgress',
    ...['awaiting_landing', 'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'expired'].map((status) => `timeline.webAnimation.status.${status}`),
    'timeline.webAnimation.step.landing', 'timeline.webAnimation.phase.writing', 'timeline.webAnimation.phase.validating', 'timeline.webAnimation.phase.saving',
    'timeline.webAnimation.usage', 'timeline.webAnimation.usagePending',
    'timeline.webAnimation.cancel', 'timeline.webAnimation.addToTimeline', 'timeline.webAnimation.addPlaceholder', 'timeline.webAnimation.retry',
    'timeline.webAnimation.failure.feature_disabled', 'timeline.webAnimation.failure.unknown',
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
