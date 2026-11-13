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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  t, type ProjectRegisteredAsset, type TimelineClip, type TimelineDocumentV1, type TimelineExecution, type TimelineTrack,
  type TimelineVideoSource,
} from '@breatic/shared';
import { initializeTimelineDocument, timelineExecutionEnded } from '@breatic/shared/space-content';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { ApiException } from '@web/data/api/types';
import { clearAllDocSizes, setDocSize, startDocResync } from '@web/data/yjs/doc-size';
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
import { gesture, moveableMock, resetMoveableMock } from '@web/spaces/timeline/__tests__/helpers/moveable-mock';
import { TimelineSpace } from '@web/spaces/timeline/TimelineSpace';
import { MAIN, clip as videoClip, seededDoc, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { P_FULL, P_NORMAL, P_OVER, P_UNLIMITED, P_WARNING, type DocSizePushV2 } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
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
  resetMoveableMock();
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
  clearAllDocSizes();
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

  // breatic#1502 design §7: the frame's own ratio when it is one of the three, otherwise the one that, contained in the
  // frame, covers most of it, ties going to the one facing the same way.
  it.each([
    ['16:9', 1920, 1080, '16:9'],
    ['9:16', 1080, 1920, '9:16'],
    ['1:1', 1080, 1080, '1:1'],
    ['21:9', 2520, 1080, '16:9'],
    ['4:3', 1440, 1080, '16:9'],
    ['4:5', 1080, 1350, '1:1'],
    ['2:3', 1080, 1620, '9:16'],
  ] as const)('opens a %s Timeline (%i x %i) with the %s aspect, whatever order the limits list them in', async (_frame, width, height, aspect) => {
    // The expected aspect is listed last, so the first listed one is never the answer.
    const aspects = [...['16:9', '9:16', '1:1'].filter((item) => item !== aspect), aspect];
    vi.mocked(timelineApi.limits).mockResolvedValue({ ...LIMITS, webAnimation: { ...LIMITS.webAnimation, aspects } } as never);
    const server = new Y.Doc();
    try {
      initializeTimelineDocument(server, { ...SETTINGS, width, height });
      Y.applyUpdate(currentDoc(), Y.encodeStateAsUpdate(server), 'provider');
    } finally { server.destroy(); }
    showTimeline();
    const dialog = await openCreate();
    expect(within(dialog).getByTestId('web-animation-aspect')).toHaveTextContent(aspect);
  });

  it('labels its fields at the standard label size and colour and keeps its controls at the standard control height', async () => {
    seed();
    showTimeline();
    const dialog = await openCreate();
    for (const key of ['prompt', 'engine', 'aspect', 'duration']) {
      const label = within(dialog).getByText(t(`timeline.webAnimation.dialog.${key}`));
      expect(label.tagName, key).toBe('LABEL');
      expect(label, key).not.toHaveClass('text-xs');
      expect(label, key).not.toHaveClass('text-muted-foreground');
    }
    for (const testId of ['web-animation-engine', 'web-animation-aspect', 'web-animation-duration']) {
      expect(within(dialog).getByTestId(testId), testId).not.toHaveClass('h-8');
    }
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

describe('creation dialog in a Space at its size limit (inner#1790 WA-01..WA-06)', () => {
  const NAME = docName.timelineSpace(PROJECT, SPACE);
  let seq = 0;
  /**
   * Push a size for a document.
   * @param name - The document.
   * @param push - The size.
   */
  function size(name: string, push: DocSizePushV2): void {
    seq += 1;
    setDocSize(name, { type: 'doc:size', seq, ...push });
  }

  /**
   * Open the dialog with a prompt typed, ready to execute.
   * @returns The dialog.
   */
  async function readyDialog(): Promise<HTMLElement> {
    seed();
    showTimeline();
    const dialog = await openCreate();
    await userEvent.type(within(dialog).getByTestId('web-animation-prompt'), 'Kept words');
    return dialog;
  }

  /**
   * Assert a refused press left everything as it was.
   * @param dialog - The dialog.
   */
  function expectNothingSent(dialog: HTMLElement): void {
    expect(timelineApi.acceptExecution).not.toHaveBeenCalled();
    expect(layout().operationReceipts).toEqual({});
    expect(webCopies()).toEqual([]);
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByTestId('web-animation-prompt')).toHaveValue('Kept words');
    expect(within(dialog).getByTestId('web-animation-execute')).not.toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('timeline-executions')).toBeNull();
  }

  it.each([
    ['WA-01 full', P_FULL, 'spaces.sizeCap.add'],
    ['WA-02 over the ceiling', P_OVER, 'spaces.sizeCap.over'],
  ] as const)('%s: Execute asks nothing, writes nothing and says why once', async (_label, push, key) => {
    const dialog = await readyDialog();
    size(NAME, push);
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));
    expectNothingSent(dialog);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(t(key));
  });

  it('WA-03 resyncing: Execute asks nothing, writes nothing and shows no toast', async () => {
    const dialog = await readyDialog();
    size(NAME, P_NORMAL);
    startDocResync(NAME);
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));
    expectNothingSent(dialog);
    for (const fn of Object.values(toast)) if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', null],
    ['unlimited', P_UNLIMITED],
    ['normal', P_NORMAL],
    ['warning', P_WARNING],
  ] as const)('WA-04 %s: Execute sends once and lands', async (_label, push) => {
    const dialog = await readyDialog();
    if (push !== null) size(NAME, push);
    const accepted = row('90000000-0000-4000-8000-0000000000e1', 'awaiting_landing');
    vi.mocked(timelineApi.acceptExecution).mockImplementation(async (body) => ({ ...accepted, actionId: body.actionId }));
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));
    await waitFor(() => expect(timelineApi.acceptExecution).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(Object.values(layout().operationReceipts)).toEqual([expect.objectContaining({ executionId: accepted.id })]));
    expect(webCopies()).toHaveLength(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('WA-05 another Space being full does not stop this one', async () => {
    const dialog = await readyDialog();
    size(NAME, P_NORMAL);
    size(docName.timelineSpace(PROJECT, '70000000-0000-4000-8000-000000000002'), P_FULL);
    size(docName.canvasSpace(PROJECT, '70000000-0000-4000-8000-000000000003'), P_FULL);
    const accepted = row('90000000-0000-4000-8000-0000000000e2', 'awaiting_landing');
    vi.mocked(timelineApi.acceptExecution).mockImplementation(async (body) => ({ ...accepted, actionId: body.actionId }));
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));
    await waitFor(() => expect(timelineApi.acceptExecution).toHaveBeenCalledTimes(1));
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('WA-06 after a refusal the kept input executes once the Space has room', async () => {
    const dialog = await readyDialog();
    size(NAME, P_FULL);
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));
    expect(timelineApi.acceptExecution).not.toHaveBeenCalled();
    size(NAME, P_NORMAL);
    const accepted = row('90000000-0000-4000-8000-0000000000e3', 'awaiting_landing');
    vi.mocked(timelineApi.acceptExecution).mockImplementation(async (body) => ({ ...accepted, actionId: body.actionId }));
    await userEvent.click(within(dialog).getByTestId('web-animation-execute'));
    await waitFor(() => expect(timelineApi.acceptExecution).toHaveBeenCalledTimes(1));
    expect(vi.mocked(timelineApi.acceptExecution).mock.calls[0]?.[0]).toMatchObject({ prompt: 'Kept words' });
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

  const FAILURE_LINES: Array<[string | null, string]> = [
    ...['validation_failed', 'font_not_in_set', 'manifest_invalid', 'package_too_large', 'output_missing', 'viewport_mismatch', 'fps_mismatch', 'duration_mismatch', 'font_set_mismatch']
      .map((reason): [string, string] => [reason, 'check']),
    ...['harness_failed', 'container_failed', 'internal'].map((reason): [string, string] => [reason, 'stopped']),
    ['feature_disabled', 'feature_disabled'],
    ['a_reason_with_no_sentence', 'unknown'],
    [null, 'unknown'],
  ];

  it.each(FAILURE_LINES)('tells a failure for reason %s with failure.%s', async (reason, line) => {
    rows = [row(EXEC_FAILED, 'failed', { failureReason: reason })];
    seed();
    showTimeline();
    await openList();
    await view('completed');
    const detail = await expand(EXEC_FAILED);
    expect(detail).toHaveTextContent(t(`timeline.webAnimation.failure.${line}`));
    if (line !== 'unknown') expect(detail).not.toHaveTextContent(t('timeline.webAnimation.failure.unknown'));
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

describe('execution row header, steps, usage and actions', () => {
  /**
   * Show only this row, in the view it belongs to.
   * @param target - The row.
   * @returns Its header toggle.
   * @throws {Error} When the row is missing.
   */
  async function showRow(target: ListedExecution): Promise<HTMLElement> {
    rows = [target];
    seed();
    showTimeline();
    await openList();
    await view(timelineExecutionEnded(target.status) ? 'completed' : 'inProgress');
    return screen.findByTestId(`timeline-execution-toggle-${target.id}`);
  }

  /**
   * The step items of an open row, in order.
   * @param detail - The row's details.
   * @returns Its steps.
   * @throws {never} Never.
   */
  function stepItems(detail: HTMLElement): HTMLElement[] {
    return [...detail.querySelectorAll<HTMLElement>('ol > li')];
  }

  it('puts the summary on its own row across the header, apart from the title, with the short duration', async () => {
    const toggle = await showRow(DONE_ROW);
    const meta = within(toggle).getByTestId(`timeline-execution-meta-${EXEC_DONE}`);
    const title = within(toggle).getByText('Brand name fades in');
    expect(meta.parentElement).not.toBe(title.parentElement);
    expect(meta).not.toContainElement(title);
    // A row across the whole header sits directly in the header, which also holds the kind icon.
    expect(meta.parentElement).toBe(toggle);
    expect(toggle).toContainElement(toggle.querySelector('svg'));
    expect(meta).toHaveTextContent('DeepSeek');
    expect(meta).toHaveTextContent('9:16');
    expect(meta).toHaveTextContent(t('timeline.webAnimation.durationShort', { seconds: 4 }));
    expect(meta).not.toHaveTextContent(t('timeline.material.duration', { seconds: 4 }));
  });

  it.each(['awaiting_landing', 'queued', 'running', 'cancelling'] as const)('spins an icon before the status of a %s row', async (status) => {
    const target = row('90000000-0000-4000-8000-0000000000f1', status, { input: { prompt: 'Spinning row', engine: 'deepseek', aspect: '16:9', durationSeconds: 3, fps: SETTINGS.fps } });
    await showRow(target);
    const holder = within(screen.getByTestId(`timeline-execution-${target.id}`)).getByTestId(`timeline-execution-status-${target.id}`);
    const spinners = holder.querySelectorAll('svg.animate-spin');
    expect(spinners).toHaveLength(1);
    expect(holder.firstChild).toBe(spinners[0]);
    expect(holder).toHaveTextContent(t(`timeline.webAnimation.status.${status}`));
    expect(holder).not.toHaveTextContent('Spinning row');
  });

  it.each([DONE_ROW, FAILED_ROW, row('90000000-0000-4000-8000-0000000000c1', 'cancelled'), row('90000000-0000-4000-8000-0000000000c3', 'expired')])(
    'spins nothing in the header of a finished row ($status)', async (target) => {
      const toggle = await showRow(target);
      const holder = within(screen.getByTestId(`timeline-execution-${target.id}`)).getByTestId(`timeline-execution-status-${target.id}`);
      expect(holder).toHaveTextContent(t(`timeline.webAnimation.status.${target.status}`));
      expect(holder.querySelector('svg.animate-spin')).toBeNull();
      expect(toggle.querySelector('svg.animate-spin')).toBeNull();
    });

  it('marks the page-writing step current for a running row that has reported no phase yet', async () => {
    await showRow(row(EXEC_RUNNING, 'running', { phase: null }));
    const steps = stepItems(await expand(EXEC_RUNNING));
    expect(steps.map((item) => item.getAttribute('data-mark'))).toEqual(['done', 'current', 'pending', 'pending']);
    expect(steps[1]).toHaveTextContent(t('timeline.webAnimation.phase.writing'));
  });

  it('marks the step a failed run stopped at in the error tone and leaves the later ones pending', async () => {
    await showRow(row(EXEC_FAILED, 'failed', { phase: 'validating', failureReason: 'validation_failed' }));
    const steps = stepItems(await expand(EXEC_FAILED));
    expect(steps.map((item) => item.getAttribute('data-mark'))).toEqual(['done', 'done', 'stopped', 'pending']);
    expect(steps[2]).toHaveClass('text-status-error-foreground');
  });

  it('marks the page-writing step stopped for a failed run that reported no phase', async () => {
    await showRow(row(EXEC_FAILED, 'failed', { phase: null }));
    const steps = stepItems(await expand(EXEC_FAILED));
    expect(steps.map((item) => item.getAttribute('data-mark'))).toEqual(['done', 'stopped', 'pending', 'pending']);
    expect(steps[1]).toHaveClass('text-status-error-foreground');
  });

  it('marks the saving step stopped in the error tone for a run that expired while saving', async () => {
    const id = '90000000-0000-4000-8000-0000000000c3';
    await showRow(row(id, 'expired', { phase: 'saving' }));
    const steps = stepItems(await expand(id));
    expect(steps.map((item) => item.getAttribute('data-mark'))).toEqual(['done', 'done', 'done', 'stopped']);
    expect(steps[3]).toHaveClass('text-status-error-foreground');
  });

  it('marks the step a cancelled run stopped at muted, not in the error tone', async () => {
    const id = '90000000-0000-4000-8000-0000000000c1';
    await showRow(row(id, 'cancelled', { phase: null }));
    const steps = stepItems(await expand(id));
    expect(steps.map((item) => item.getAttribute('data-mark'))).toEqual(['done', 'stopped', 'pending', 'pending']);
    expect(steps[1]).not.toHaveClass('text-status-error-foreground');
  });

  it('lists the usage of a finished row as a labelled term beside the prompt', async () => {
    await showRow(DONE_ROW);
    const detail = await expand(EXEC_DONE);
    const label = within(detail).getByText(t('timeline.webAnimation.usageLabel'));
    expect(label.tagName).toBe('DT');
    const value = label.nextElementSibling as HTMLElement;
    expect(value.tagName).toBe('DD');
    expect(value.previousElementSibling).toBe(label);
    expect(value).toHaveTextContent(t('timeline.webAnimation.usage', { credits: '0.38' }));
    expect(label.parentElement).toBe(within(detail).getByText(t('timeline.webAnimation.dialog.prompt')).parentElement);
  });

  it('lists the usage of an unfinished row as pending', async () => {
    await showRow(RUNNING_ROW);
    const detail = await expand(EXEC_RUNNING);
    const label = within(detail).getByText(t('timeline.webAnimation.usageLabel'));
    expect(label.tagName).toBe('DT');
    const value = label.nextElementSibling as HTMLElement;
    expect(value.tagName).toBe('DD');
    expect(value).toHaveTextContent(t('timeline.webAnimation.usagePending'));
    expect(label.parentElement).toBe(within(detail).getByText(t('timeline.webAnimation.dialog.prompt')).parentElement);
  });

  it('spaces the icon and label of every row action alike', async () => {
    rows = [RUNNING_ROW, DONE_ROW, FAILED_ROW];
    seed();
    showTimeline();
    await openList();
    await view('inProgress');
    const running = await expand(EXEC_RUNNING);
    expect(within(running).getByTestId(`timeline-execution-cancel-${EXEC_RUNNING}`)).toHaveClass('gap-1.5');
    expect(within(running).getByTestId(`timeline-execution-add-placeholder-${EXEC_RUNNING}`)).toHaveClass('gap-1.5');
    await view('completed');
    const done = await expand(EXEC_DONE);
    expect(within(done).getByTestId(`timeline-execution-add-${EXEC_DONE}`)).toHaveClass('gap-1.5');
    const failed = await expand(EXEC_FAILED);
    expect(within(failed).getByTestId(`timeline-execution-retry-${EXEC_FAILED}`)).toHaveClass('gap-1.5');
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

  it('mounts a player for a copy under a higher video, stacked below that video (breatic#1410 §6.1)', async () => {
    rows = [SOURCE_A_ROW];
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
    rows = [SOURCE_A_ROW];
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
    rows = [RUNNING_ROW];
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
    rows = [FAILED_ROW];
    const failed = '30000000-0000-4000-8000-000000000108';
    seed([webClip(failed, 'v2', 0, 48, waitingFor(EXEC_FAILED))]);
    showTimeline();
    const note = await screen.findByTestId(`timeline-preview-note-${failed}`);
    await waitFor(() => expect(note).toHaveTextContent(t('timeline.webAnimation.preview.failed', { track: t('timeline.track', { index: 2 }), status: 'failed' })));
    expect(note).toHaveTextContent('web animation failed');
  });

  it('notes a copy whose preview address cannot be had and fetches a new one on retry', async () => {
    rows = [SOURCE_A_ROW];
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
    rows = [SOURCE_A_ROW];
    // With idle instances kept, only the failure decides that the refused instance is unloaded rather than idled.
    vi.mocked(timelineApi.limits).mockResolvedValue({ ...LIMITS, webAnimation: { ...LIMITS.webAnimation, idleInstancesMax: 2 } } as never);
    vi.mocked(timelineApi.previewUrl).mockRejectedValueOnce(new ApiException({ status: 404, message: 'Not found', fromServer: true }));
    const first = '30000000-0000-4000-8000-000000000106';
    const later = '30000000-0000-4000-8000-000000000107';
    seed([webClip(first, 'v2', 0, 48, boundTo(SRC_A)), webClip(later, 'v2', 96, 48, boundTo(SRC_A))]);
    showTimeline();
    // The creation control shows once the Timeline limits, and so the idle cap, have arrived.
    await screen.findByTestId('timeline-create-web-animation');
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
    rows = [SOURCE_A_ROW];
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
   * Whether the play bar shows the buffering text.
   * @returns True while it does.
   * @throws {never} Never.
   */
  function buffering(): boolean {
    return screen.queryByText(t('timeline.transport.waiting')) !== null;
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
    'timeline.webAnimation.usageLabel', 'timeline.webAnimation.usage', 'timeline.webAnimation.usagePending', 'timeline.webAnimation.durationShort',
    'timeline.webAnimation.cancel', 'timeline.webAnimation.addToTimeline', 'timeline.webAnimation.addPlaceholder', 'timeline.webAnimation.retry',
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

  it('has the agreed English sentences for usage, failures and preview notes', () => {
    const english = LOCALE_CATALOGS[0]?.[1] ?? {};
    expect(readPath(english, 'timeline.webAnimation.usageLabel')).toBe('Usage');
    expect(readPath(english, 'timeline.webAnimation.usage')).toBe('{credits} credits');
    expect(readPath(english, 'timeline.webAnimation.usagePending')).toBe('Settled when it ends');
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
