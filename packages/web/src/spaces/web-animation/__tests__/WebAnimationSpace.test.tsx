// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Motion Space as users meet it (#1490 design §7): no top bar, the preview filling the Space, and one floating
 * bottom bar of icon buttons with play first and the Executions, Annotations and New group last. The two panels open
 * one at a time, docked inside the Space; a Viewer sees no New. With no result the preview offers New; otherwise it
 * opens the newest finished result.
 */

import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { t } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { getSceneControls } from '@web/data/api/scene';
import type * as SceneApiModule from '@web/data/api/scene';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import type { SocketState } from '@web/data/yjs/use-socket';
import { toast } from '@web/lib/toast';
import { placeVideoOnCanvas } from '@web/spaces/canvas/place-video-on-canvas';
import { asCommentBody } from '@web/spaces/document/document-comment-extension';
import { bodyText } from '@web/spaces/document/use-comment-cards';
import { webAnimationAnnotationStore } from '@web/spaces/web-animation/annotation-thread-store';
import { WebAnimationSpace } from '@web/spaces/web-animation/WebAnimationSpace';
import { useSpaceOpenRequestStore } from '@web/stores/space-open-request';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return {
    ...actual,
    timelineApi: { ...actual.timelineApi, listSpaceExecutions: vi.fn(), getExecution: vi.fn(), previewUrl: vi.fn(), limits: vi.fn(), resolveAsset: vi.fn(), acceptExecution: vi.fn() },
  };
});
vi.mock('@hyperframes/player', () => ({}));
vi.mock('@web/data/api/scene', async (importOriginal) => ({ ...await importOriginal<typeof SceneApiModule>(), getSceneControls: vi.fn() }));
vi.mock('@web/spaces/canvas/place-video-on-canvas', () => ({ placeVideoOnCanvas: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const OLDER = '90000000-0000-4000-8000-000000000001';
const NEWER = '90000000-0000-4000-8000-000000000002';
const EXPORT = '90000000-0000-4000-8000-0000000000e1';
const CONNECTED: SocketState = { provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null };
const LIMITS = {
  defaults: { width: 1920, height: 1080, fps: { num: 24, den: 1 } },
  assets: { pageSize: 50, pageMax: 100 },
  webAnimation: { promptMaxLength: 4000, durationSeconds: { min: 1, max: 60, default: 4 }, aspects: ['16:9', '9:16', '1:1'], playerLoadTimeoutMs: 15000, sourceRefreshIntervalMs: 3_600_000 },
};
const clients: QueryClient[] = [];

/**
 * A finished create row as the list answers it.
 * @param id - The execution.
 * @param request - Its request.
 * @param createdAt - When it was made.
 * @returns The row.
 */
function done(id: string, request: string, createdAt: string): Record<string, unknown> {
  return {
    id, projectId: PROJECT, spaceId: SPACE, actorUserId: 'u1', actionId: id, inputHash: 'sha256:x', attempt: 1, fence: null,
    billedCredits: '0.30', billedAt: createdAt, origin: 'web_animation_space', status: 'succeeded', phase: null, steps: [],
    failureReason: null, ownProject: true, usageCredits: 0.3, deadlineAt: createdAt, createdAt, updatedAt: createdAt,
    kind: 'web_animation_create', engine: 'deepseek', request, export: null,
    input: { prompt: request, engine: 'deepseek', aspect: '16:9', durationSeconds: 4, fps: { num: 24, den: 1 } },
    resultSourceVersionId: `80000000-0000-4000-8000-${id.slice(-12)}`, resultAssetId: null,
  };
}

/**
 * A finished export of a finished create row, as the list answers it.
 * @param source - The create row it renders.
 * @returns The row.
 */
function exported(source: Record<string, unknown>): Record<string, unknown> {
  const { engine: _engine, request: _request, export: _export, resultSourceVersionId: _version, input: _input, ...common } = source;
  return {
    ...common, id: EXPORT, actionId: EXPORT, kind: 'web_animation_export', engine: null, resultSourceVersionId: null, resultAssetId: null,
    input: { sourceVersionId: source.resultSourceVersionId, width: 1920, height: 1080, fps: { num: 24, den: 1 }, durationFrames: 96, videoKey: 'v/k.mp4' },
    source: { executionId: source.id, request: source.request },
  };
}

/**
 * Answer this Space's list with these rows in the done group, nothing in progress and no Timeline-made group.
 * @param rows - The finished rows, newest first.
 */
function listing(rows: Array<Record<string, unknown>>): void {
  vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(async (params: { group?: string; scope?: string }) => (
    params.group === 'running' || params.scope === 'timeline'
      ? { rows: [], nextCursor: null, totals: params.scope === 'timeline' ? { done: 0, inProgress: 0 } : { done: rows.length, inProgress: 0 } }
      : { rows, nextCursor: null, totals: { done: rows.length, inProgress: 0 } }
  ) as never);
}

/**
 * Render the Motion Space for an Editor or a Viewer.
 * @param readOnly - Whether the user is a Viewer.
 * @returns The Space's element.
 */
function show(readOnly = false): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={CONNECTED}>
    <div data-region='space' data-testid='space-region'>
      <WebAnimationSpace projectId={PROJECT} spaceId={SPACE} readOnly={readOnly} myRole={readOnly ? 'viewer' : 'editor'} />
    </div>
  </SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>);
  return screen.getByTestId('space-region');
}

/**
 * Seed annotation threads into the Space's document before it opens.
 * @param anchors - Each thread's words, result and time.
 */
async function seedThreads(anchors: Array<{ text: string; executionId: string; timeSeconds: number }>): Promise<void> {
  const store = webAnimationAnnotationStore({ doc: getDoc(docName.webAnimationSpace(PROJECT, SPACE)), readWho: () => ({ role: 'editor', viewerId: 'u1' }) });
  for (const { text, executionId, timeSeconds } of anchors) {
    await store.createThread({ initialComment: { body: asCommentBody(text) as never }, metadata: { webAnimationAnchor: { executionId, timeSeconds, point: null } } });
  }
}

beforeEach(() => {
  _resetForTests();
  listing([]);
  vi.mocked(timelineApi.limits).mockReset().mockResolvedValue(LIMITS as never);
  vi.mocked(timelineApi.previewUrl).mockReset().mockResolvedValue({ url: 'https://preview.example/web-animation/t/index.html' });
});

afterEach(() => {
  cleanup();
  resetRunOnceForTests();
  useSpaceOpenRequestStore.setState({ state: { status: 'none' } });
  for (const client of clients.splice(0)) client.clear();
  _resetForTests();
});

describe('the bottom bar', () => {
  it('holds every control: play first, the Executions, Annotations and New group last', async () => {
    show();
    const bar = await screen.findByTestId('motion-bottom-bar');
    const ids = within(bar).getAllByRole('button').map((button) => button.getAttribute('data-testid'));
    expect(ids[0]).toBe('motion-play');
    expect(ids.slice(-3)).toEqual(['motion-open-executions', 'motion-open-annotations', 'motion-new']);
  });

  it('shows icons only, named by their tooltips', async () => {
    show();
    for (const [id, key] of [['motion-open-executions', 'spaces.webAnimation.executions'], ['motion-open-annotations', 'spaces.webAnimation.annotations'], ['motion-new', 'spaces.webAnimation.new']] as const) {
      const button = await screen.findByTestId(id);
      expect(button).toHaveAccessibleName(t(key));
      expect(button.textContent?.trim()).toBe('');
    }
  });

  it('draws New as a plus, apart from the Space type\'s own icon', async () => {
    show();
    const button = await screen.findByTestId('motion-new');
    expect(button.querySelector('svg.lucide-plus')).not.toBeNull();
    expect(button.querySelector('svg.lucide-clapperboard')).toBeNull();
  });

  it('has no top bar above the preview', async () => {
    show();
    await screen.findByTestId('motion-bottom-bar');
    expect(screen.queryByTestId('motion-top-bar')).toBeNull();
  });

  it('shows a Viewer the lists but not New', async () => {
    show(true);
    expect(await screen.findByTestId('motion-open-executions')).toBeInTheDocument();
    expect(screen.getByTestId('motion-open-annotations')).toBeInTheDocument();
    expect(screen.queryByTestId('motion-new')).toBeNull();
  });
});

describe('the preview', () => {
  it('offers New in the middle when the Space has no web animation yet', async () => {
    show();
    const empty = await screen.findByTestId('motion-empty');
    expect(empty).toHaveTextContent(t('spaces.webAnimation.empty'));
    expect(within(empty).getByTestId('motion-empty-new')).toBeInTheDocument();
  });

  it('opens the newest finished result', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z'), done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z')]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
  });

  it('opens the newest finished result when an open request that names no result opened the Space', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z'), done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z')]);
    useSpaceOpenRequestStore.setState({ state: { status: 'opened', request: { type: 'web_animation' }, spaceId: SPACE } });
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    expect(useSpaceOpenRequestStore.getState().state.status).toBe('none');
  });

  it('opens the newest finished result when the result an open request named cannot be read', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    vi.mocked(timelineApi.getExecution).mockReset().mockRejectedValue(new Error('not found'));
    useSpaceOpenRequestStore.setState({ state: { status: 'opened', request: { type: 'web_animation', select: OLDER }, spaceId: SPACE } });
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
  });
});

describe('the two panels', () => {
  it('opens the execution list docked inside the Space, and closes it on a second press', async () => {
    const region = show();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-open-executions'));
    const panel = await screen.findByTestId('motion-panel-executions');
    expect(region.contains(panel)).toBe(true);
    expect(screen.getByTestId('motion-open-executions')).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByTestId('motion-open-executions'));
    expect(screen.queryByTestId('motion-panel-executions')).toBeNull();
  });

  it('stacks the panels inside the Space, under the Space notices drawn over it', async () => {
    show();
    // Its own stacking context keeps every z-index inside below the outlet's read-only and size notices (z-10).
    expect(await screen.findByTestId('motion-space')).toHaveClass('isolate');
  });

  it('keeps one panel open at a time and closes it with Esc', async () => {
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-open-executions'));
    await user.click(screen.getByTestId('motion-open-annotations'));
    expect(screen.queryByTestId('motion-panel-executions')).toBeNull();
    expect(await screen.findByTestId('motion-panel-annotations')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('motion-panel-annotations')).toBeNull();
  });

  it('lists finished rows under Completed with the group totals, titled by the one title rule', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    await userEvent.setup().click(await screen.findByTestId('motion-open-executions'));
    const panel = await screen.findByTestId('motion-panel-executions');
    expect(await within(panel).findByTestId(`motion-row-${NEWER}`)).toHaveTextContent('Newer logo');
    expect(within(panel).getByRole('tab', { name: new RegExp(t('spaces.webAnimation.completed')) })).toHaveTextContent('1');
  });
});

describe('the current result\'s actions', () => {
  it('offers an Editor Add annotation, Modify and Export on a finished result', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    const bar = await screen.findByTestId('motion-bottom-bar');
    expect(await within(bar).findByTestId('motion-action-add-annotation')).toHaveAccessibleName(t('spaces.webAnimation.addAnnotation'));
    expect(within(bar).getByTestId('motion-action-modify')).toHaveAccessibleName(t('spaces.webAnimation.modify'));
    expect(within(bar).getByTestId('motion-action-export')).toHaveAccessibleName(t('spaces.webAnimation.export'));
  });

  it('turns Export into View video when this Space already has the result\'s export', async () => {
    const exportId = '90000000-0000-4000-8000-0000000000e1';
    listing([{ ...done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z'), export: { executionId: exportId, status: 'running' } }]);
    show();
    const bar = await screen.findByTestId('motion-bottom-bar');
    expect(await within(bar).findByTestId('motion-action-view-video')).toHaveAccessibleName(t('spaces.webAnimation.viewVideo'));
    expect(within(bar).queryByTestId('motion-action-export')).toBeNull();
  });

  it('shows a Viewer none of the actions that write', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show(true);
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    for (const id of ['motion-action-add-annotation', 'motion-action-modify', 'motion-action-export']) expect(screen.queryByTestId(id)).toBeNull();
  });
});


describe('switching result while an annotation is being added', () => {
  /**
   * List a finished result that already has its export, and open it.
   * @returns The user.
   */
  async function onResultWithVideo(): Promise<ReturnType<typeof userEvent.setup>> {
    const source = { ...done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z'), export: { executionId: EXPORT, status: 'succeeded' } };
    listing([source, exported(source), done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z')]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('motion-action-add-annotation'));
    await screen.findByTestId('motion-annotation-draft');
    return user;
  }

  it('closes a draft with no words and shows the result asked for', async () => {
    const user = await onResultWithVideo();
    await user.click(screen.getByTestId('motion-action-view-video'));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', EXPORT));
    expect(screen.queryByTestId('motion-annotation-draft')).toBeNull();
    expect(screen.queryByTestId('motion-discard-annotation')).toBeNull();
  });

  it('asks before throwing words away, and shows the result asked for once the user agrees', async () => {
    const user = await onResultWithVideo();
    await user.type(screen.getByTestId('doc-comment-motion-annotation-input'), 'Logo too small');
    await user.click(screen.getByTestId('motion-action-view-video'));
    expect(await screen.findByTestId('motion-discard-annotation')).toBeInTheDocument();
    expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER);
    await user.click(screen.getByTestId('motion-discard-annotation'));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', EXPORT));
    expect(screen.queryByTestId('motion-annotation-draft')).toBeNull();
  });

  it('opens the row picked in the execution list once the user agrees to discard', async () => {
    const user = await onResultWithVideo();
    await user.type(screen.getByTestId('doc-comment-motion-annotation-input'), 'Logo too small');
    await user.click(screen.getByTestId('motion-open-executions'));
    await user.click(await screen.findByTestId(`motion-row-${OLDER}`));
    await user.click(await screen.findByTestId('motion-discard-annotation'));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', OLDER));
  });

  it('keeps the draft and the result when the user keeps writing', async () => {
    const user = await onResultWithVideo();
    await user.type(screen.getByTestId('doc-comment-motion-annotation-input'), 'Logo too small');
    await user.click(screen.getByTestId('motion-action-view-video'));
    await user.click(await screen.findByRole('button', { name: t('spaces.webAnimation.keepWriting') }));
    expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER);
    expect(screen.getByTestId('doc-comment-motion-annotation-input')).toHaveValue('Logo too small');
  });

  it('closes the draft before an open request shows the result it names', async () => {
    const user = await onResultWithVideo();
    await user.click(screen.getByTestId('doc-comment-motion-annotation-input'));
    act(() => useSpaceOpenRequestStore.setState({ state: { status: 'opened', request: { type: 'web_animation', select: OLDER }, spaceId: SPACE } }));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', OLDER));
    expect(screen.queryByTestId('motion-annotation-draft')).toBeNull();
  });
});

describe('opening an annotation', () => {
  it('jumps back to its time when its card is already open', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('motion-action-add-annotation'));
    await user.type(await screen.findByTestId('doc-comment-motion-annotation-input'), 'Logo too small');
    await user.click(screen.getByTestId('doc-comment-motion-annotation-save'));
    await waitFor(() => expect(screen.queryByTestId('motion-annotation-draft')).toBeNull());
    const bar = screen.getByTestId('motion-bottom-bar');
    within(bar).getByRole('slider').focus();
    await user.keyboard('{End}');
    expect(bar).toHaveTextContent('0:04.0 / 0:04.0');
    await user.click(screen.getByTestId('motion-open-annotations'));
    const panel = await screen.findByTestId('motion-panel-annotations');
    await user.click(within(panel).getByRole('button', { name: /Logo too small/ }));
    expect(bar).toHaveTextContent('0:00.0 / 0:04.0');
  });

  const GONE = '90000000-0000-4000-8000-0000000000d1';

  /**
   * Open a thread from the annotation panel by its words.
   * @param user - The user.
   * @param text - The thread's words.
   */
  async function openFromPanel(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
    if (screen.queryByTestId('motion-panel-annotations') === null) await user.click(screen.getByTestId('motion-open-annotations'));
    const panel = await screen.findByTestId('motion-panel-annotations');
    await user.click(within(panel).getByRole('button', { name: new RegExp(text) }));
  }

  it('lands on the newly opened thread\'s time after the result an earlier thread named could not be read', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    vi.mocked(timelineApi.getExecution).mockReset().mockRejectedValue(new Error('not found'));
    await seedThreads([{ text: 'Gone note', executionId: GONE, timeSeconds: 3 }, { text: 'Shown note', executionId: NEWER, timeSeconds: 1 }]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await openFromPanel(user, 'Gone note');
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(t('spaces.webAnimation.notFound')));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    await openFromPanel(user, 'Shown note');
    expect(screen.getByTestId('motion-bottom-bar')).toHaveTextContent('0:01.0 / 0:04.0');
  });

  it('lands on the newly opened thread\'s time after the user picked another row while an earlier one was read', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z'), done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z')]);
    vi.mocked(timelineApi.getExecution).mockReset().mockReturnValue(new Promise(() => {}));
    await seedThreads([{ text: 'Gone note', executionId: GONE, timeSeconds: 3 }, { text: 'Older note', executionId: OLDER, timeSeconds: 2 }]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await openFromPanel(user, 'Gone note');
    await screen.findByTestId('motion-loading');
    await user.click(screen.getByTestId('motion-open-executions'));
    await user.click(await screen.findByTestId(`motion-row-${OLDER}`));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', OLDER));
    await openFromPanel(user, 'Older note');
    expect(screen.getByTestId('motion-bottom-bar')).toHaveTextContent('0:02.0 / 0:04.0');
  });

  it('lands on the marker\'s time when it is opened on the shown result after a read that never landed', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    vi.mocked(timelineApi.getExecution).mockReset().mockReturnValue(new Promise(() => {}));
    await seedThreads([{ text: 'Gone note', executionId: GONE, timeSeconds: 3 }, { text: 'Shown note', executionId: NEWER, timeSeconds: 1 }]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await openFromPanel(user, 'Gone note');
    await screen.findByTestId('motion-loading');
    await user.click(screen.getByTestId('motion-open-executions'));
    await user.click(await screen.findByTestId(`motion-row-${NEWER}`));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    await user.click(screen.getByRole('button', { name: 'Shown note' }));
    expect(screen.getByTestId('motion-bottom-bar')).toHaveTextContent('0:01.0 / 0:04.0');
  });

  it('keeps an unsent reply with its own thread, and Reply posts each thread\'s own words to it', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    await seedThreads([{ text: 'First note', executionId: NEWER, timeSeconds: 1 }, { text: 'Second note', executionId: NEWER, timeSeconds: 2 }]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await openFromPanel(user, 'First note');
    await user.type(within(await screen.findByTestId('motion-thread-card')).getByTestId('doc-comment-reply-input'), 'For the first');
    await openFromPanel(user, 'Second note');
    const card = screen.getByTestId('motion-thread-card');
    expect(within(card).getByTestId('doc-comment-reply-input')).toHaveValue('');
    await user.type(within(card).getByTestId('doc-comment-reply-input'), 'For the second');
    await user.click(within(card).getByTestId('doc-comment-reply-save'));
    const threads = [...webAnimationAnnotationStore({ doc: getDoc(docName.webAnimationSpace(PROJECT, SPACE)), readWho: () => ({ role: 'editor', viewerId: 'u1' }) }).getThreads().values()];
    const bodies = (words: string): string[] => (threads.find((thread) => bodyText(thread.comments[0]!.body) === words)?.comments ?? []).map((comment) => bodyText(comment.body));
    await waitFor(() => expect(bodies('Second note')).toEqual(['Second note', 'For the second']));
    expect(bodies('First note')).toEqual(['First note']);
    await openFromPanel(user, 'First note');
    expect(within(screen.getByTestId('motion-thread-card')).getByTestId('doc-comment-reply-input')).toHaveValue('For the first');
  });
});

describe('the result a modification started from', () => {
  const MODIFIED = '90000000-0000-4000-8000-0000000000a1';

  /**
   * List a finished modification of OLDER, newest, with OLDER below it, and open it.
   * @returns The user.
   */
  async function onModification(): Promise<ReturnType<typeof userEvent.setup>> {
    listing([{
      ...done(MODIFIED, 'Make the logo bigger', '2026-11-15T09:30:00.000000Z'), kind: 'web_animation_modify', base: { executionId: OLDER, request: 'Older logo' },
      input: { baseSourceVersionId: `80000000-0000-4000-8000-${OLDER.slice(-12)}`, instruction: 'Make the logo bigger', engine: 'deepseek', aspect: '16:9', durationSeconds: 4, fps: { num: 24, den: 1 } },
    }, done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z')]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', MODIFIED));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('motion-details'));
    return user;
  }

  it('opens the original result\'s annotations at its earliest open one', async () => {
    await seedThreads([
      { text: 'Later open note', executionId: OLDER, timeSeconds: 3 },
      { text: 'Settled note', executionId: OLDER, timeSeconds: 1 },
      { text: 'Earliest open note', executionId: OLDER, timeSeconds: 2 },
    ]);
    const store = webAnimationAnnotationStore({ doc: getDoc(docName.webAnimationSpace(PROJECT, SPACE)), readWho: () => ({ role: 'editor', viewerId: 'u1' }) });
    const settled = [...store.getThreads().values()].find((thread) => bodyText(thread.comments[0]!.body) === 'Settled note')!;
    await store.resolveThread({ threadId: settled.id });
    const user = await onModification();
    await user.click(await screen.findByRole('button', { name: t('spaces.webAnimation.baseWithAnnotations', { base: 'Older logo', count: 2 }) }));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', OLDER));
    expect(await screen.findByTestId('motion-panel-annotations')).toBeInTheDocument();
    expect(screen.getByTestId('motion-bottom-bar')).toHaveTextContent('0:02.0 / 0:04.0');
    expect(within(screen.getByTestId('motion-thread-card')).getByText('Earliest open note')).toBeInTheDocument();
  });

  it('shows the original result when it has no open annotation', async () => {
    const user = await onModification();
    await user.click(await screen.findByRole('button', { name: 'Older logo' }));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', OLDER));
    expect(screen.queryByTestId('motion-panel-annotations')).toBeNull();
  });
});

describe('a preview that cannot load', () => {
  it('says the result a modification starts from is unavailable, and reads it again on Retry', async () => {
    const base = '90000000-0000-4000-8000-0000000000b1';
    const created = done(NEWER, 'Make the dot red', '2026-11-15T09:00:00.000000Z');
    listing([{
      ...created, kind: 'web_animation_modify', status: 'failed', failureReason: 'check', resultSourceVersionId: null, base: { executionId: base, request: 'Gold dot' },
      input: { baseSourceVersionId: '80000000-0000-4000-8000-0000000000b1', instruction: 'Make the dot red', engine: 'deepseek', aspect: '16:9', durationSeconds: 4, fps: { num: 24, den: 1 } },
    }]);
    vi.mocked(timelineApi.getExecution).mockReset().mockRejectedValue(new Error('network'));
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-retry'));
    const card = await screen.findByTestId('web-animation-base');
    expect(await within(card).findByText(t('timeline.webAnimation.unavailable'))).toBeInTheDocument();
    const reads = vi.mocked(timelineApi.getExecution).mock.calls.length;
    await user.click(within(card).getByRole('button', { name: t('timeline.retry') }));
    await waitFor(() => expect(vi.mocked(timelineApi.getExecution).mock.calls.length).toBeGreaterThan(reads));
  });

  /**
   * List a finished export whose video asset is this one, and open it.
   * @returns The user.
   */
  async function onExport(): Promise<ReturnType<typeof userEvent.setup>> {
    const source = done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z');
    listing([{ ...exported(source), resultAssetId: '50000000-0000-4000-8000-000000000001' }]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', EXPORT));
    return userEvent.setup();
  }

  it('says an export whose video cannot be read is unavailable, and reads it again on Retry', async () => {
    vi.mocked(timelineApi.resolveAsset).mockReset().mockRejectedValue(new Error('network'));
    const user = await onExport();
    const preview = screen.getByTestId('motion-preview');
    expect(await within(preview).findByText(t('timeline.webAnimation.unavailable'))).toBeInTheDocument();
    const reads = vi.mocked(timelineApi.resolveAsset).mock.calls.length;
    await user.click(within(preview).getByRole('button', { name: t('timeline.retry') }));
    await waitFor(() => expect(vi.mocked(timelineApi.resolveAsset).mock.calls.length).toBeGreaterThan(reads));
  });

  it('says an export whose video fails to play is unavailable, and loads it again on Retry', async () => {
    vi.mocked(timelineApi.resolveAsset).mockReset().mockResolvedValue({ fileUrl: 'https://cdn.example/v.mp4', coverUrl: null, mimeType: 'video/mp4', sizeBytes: 1, width: 1920, height: 1080, durationSeconds: 4 } as never);
    const user = await onExport();
    const preview = screen.getByTestId('motion-preview');
    const video = await waitFor(() => { const found = preview.querySelector('video'); expect(found).not.toBeNull(); return found as HTMLVideoElement; });
    fireEvent.error(video);
    await user.click(await within(preview).findByRole('button', { name: t('timeline.retry') }));
    expect(preview.querySelector('video')).not.toBeNull();
    expect(within(preview).queryByText(t('timeline.webAnimation.unavailable'))).toBeNull();
  });
});

/** Read every list again and let React Query tell its observers, which it does on a timer after the read settles. */
async function refetchFailing(): Promise<void> {
  await act(async () => { await clients.at(-1)!.refetchQueries(); await new Promise((resolve) => setTimeout(resolve, 10)); });
}

describe('the execution list when a read fails', () => {
  it('keeps the rows when Load more fails, and turns Load more into Retry', async () => {
    const first = done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z');
    vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(async (params: { group?: string; scope?: string; cursor?: string }) => {
      if (params.group === 'running' || params.scope === 'timeline') return { rows: [], nextCursor: null, totals: { done: 0, inProgress: 0 } } as never;
      if (params.cursor !== undefined) throw new Error('network');
      return { rows: [first], nextCursor: 'next', totals: { done: 2, inProgress: 0 } } as never;
    });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-open-executions'));
    const panel = await screen.findByTestId('motion-panel-executions');
    await user.click(await within(panel).findByRole('button', { name: t('timeline.webAnimation.picker.loadMore') }));
    expect(await within(panel).findByRole('button', { name: t('timeline.retry') })).toBeInTheDocument();
    expect(within(panel).getByTestId(`motion-row-${NEWER}`)).toBeInTheDocument();
    expect(within(panel).queryByText(t('spaces.webAnimation.listError'))).toBeNull();
  });

  it('says the list failed on a first read, and shows the list loading while Retry reads it again', async () => {
    vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(async (params: { group?: string; scope?: string }) => {
      if (params.group === 'running' || params.scope === 'timeline') return { rows: [], nextCursor: null, totals: { done: 0, inProgress: 0 } } as never;
      throw new Error('network');
    });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-open-executions'));
    const panel = await screen.findByTestId('motion-panel-executions');
    expect(await within(panel).findByText(t('spaces.webAnimation.listError'))).toBeInTheDocument();
    vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(() => new Promise(() => {}));
    await user.click(within(panel).getByRole('button', { name: t('timeline.retry') }));
    await waitFor(() => expect(within(panel).queryByText(t('spaces.webAnimation.listError'))).toBeNull());
    expect(panel.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0);
  });

  it('keeps the rows when a background read fails', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    await userEvent.setup().click(await screen.findByTestId('motion-open-executions'));
    const panel = await screen.findByTestId('motion-panel-executions');
    await within(panel).findByTestId(`motion-row-${NEWER}`);
    vi.mocked(timelineApi.listSpaceExecutions).mockRejectedValue(new Error('network'));
    await refetchFailing();
    expect(within(panel).getByTestId(`motion-row-${NEWER}`)).toBeInTheDocument();
    expect(within(panel).queryByText(t('spaces.webAnimation.listError'))).toBeNull();
  });
});

describe('the preview when the list read fails', () => {
  /** Fail every read of this Space's Completed list; the other lists answer empty. */
  function failDone(): void {
    vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(async (params: { group?: string; scope?: string }) => {
      if (params.group === 'running' || params.scope === 'timeline') return { rows: [], nextCursor: null, totals: { done: 0, inProgress: 0 } } as never;
      throw new Error('network');
    });
  }

  it('says the list failed with Retry on a failed first read, and waits while Retry reads it again', async () => {
    failDone();
    show();
    const preview = await screen.findByText(t('spaces.webAnimation.listError'));
    expect(screen.queryByTestId('motion-loading')).toBeNull();
    vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(() => new Promise(() => {}));
    await userEvent.setup().click(within(preview.parentElement as HTMLElement).getByRole('button', { name: t('timeline.retry') }));
    expect(await screen.findByTestId('motion-loading')).toBeInTheDocument();
    expect(screen.queryByText(t('spaces.webAnimation.listError'))).toBeNull();
  });

  it('keeps the empty state when a background read of the list fails', async () => {
    show();
    await screen.findByTestId('motion-empty');
    failDone();
    await refetchFailing();
    expect(screen.getByTestId('motion-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('motion-loading')).toBeNull();
  });

  it('still opens the newest finished result after a background read failed and a named result could not be read', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    failDone();
    await refetchFailing();
    vi.mocked(timelineApi.getExecution).mockReset().mockRejectedValue(new Error('not found'));
    act(() => useSpaceOpenRequestStore.setState({ state: { status: 'opened', request: { type: 'web_animation', select: OLDER }, spaceId: SPACE } }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(t('spaces.webAnimation.notFound')));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
  });
});

describe('exporting a result', () => {
  beforeEach(() => {
    vi.mocked(timelineApi.acceptExecution).mockReset().mockReturnValue(new Promise(() => {}));
  });

  /**
   * Press a button twice before any answer, and see one request go and the button wait.
   * @param testId - The button.
   */
  async function pressTwice(testId: string): Promise<void> {
    const button = await screen.findByTestId(testId);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(timelineApi.acceptExecution).toHaveBeenCalledOnce());
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(timelineApi.acceptExecution).toHaveBeenCalledOnce();
    expect(screen.getByTestId(testId)).toHaveAttribute('aria-busy', 'true');
  }

  it('sends one export for two quick presses of Export, which waits for the answer', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    await pressTwice('motion-action-export');
  });

  it('sends one export for two quick presses of Re-export, which waits for the answer', async () => {
    listing([{ ...exported(done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z')), status: 'failed', failureReason: 'render' }]);
    show();
    await pressTwice('motion-retry');
  });
});

describe('putting an export on a Canvas', () => {
  const CANVAS = '70000000-0000-4000-8000-0000000000c1';
  const CONTROLS = { capture: { canvasSyncTimeoutMs: 10_000 } };

  /**
   * Give the Project one Canvas, list a finished export with its video, and open it.
   * @returns The user.
   */
  async function onExportWithCanvas(): Promise<ReturnType<typeof userEvent.setup>> {
    const canvas = new Y.Map<unknown>();
    getDoc(docName.projectMeta(PROJECT)).getMap<Y.Map<unknown>>('spaces').set(CANVAS, canvas);
    for (const [key, value] of Object.entries({ id: CANVAS, name: 'Board', type: 'canvas', createdAt: 1 })) canvas.set(key, value);
    vi.mocked(timelineApi.resolveAsset).mockReset().mockResolvedValue({ fileUrl: 'https://cdn.example/v.mp4', coverUrl: null, mimeType: 'video/mp4', sizeBytes: 1, width: 1920, height: 1080, durationSeconds: 4 } as never);
    listing([{ ...exported(done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z')), resultAssetId: '50000000-0000-4000-8000-000000000001' }]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', EXPORT));
    return userEvent.setup();
  }

  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(placeVideoOnCanvas).mockReset().mockResolvedValue({ status: 'placed', nodeId: 'node-1' });
  });

  it('shows the button waiting while the placement settings are read', async () => {
    vi.mocked(getSceneControls).mockReset().mockReturnValue(new Promise(() => {}));
    await onExportWithCanvas();
    await waitFor(() => expect(screen.getByTestId('motion-action-place-on-canvas')).toHaveAttribute('aria-busy', 'true'));
  });

  it('says it failed and reads the settings again when they could not be read', async () => {
    vi.mocked(getSceneControls).mockReset().mockRejectedValue(new Error('network'));
    const user = await onExportWithCanvas();
    await waitFor(() => expect(screen.getByTestId('motion-action-place-on-canvas')).not.toHaveAttribute('aria-busy'));
    const reads = vi.mocked(getSceneControls).mock.calls.length;
    await user.click(screen.getByTestId('motion-action-place-on-canvas'));
    await user.click(await screen.findByTestId(`motion-canvas-${CANVAS}`));
    expect(toast.error).toHaveBeenCalled();
    await waitFor(() => expect(vi.mocked(getSceneControls).mock.calls.length).toBeGreaterThan(reads));
    expect(placeVideoOnCanvas).not.toHaveBeenCalled();
  });

  it('offers View on the placed toast in Motion\'s own words', async () => {
    vi.mocked(getSceneControls).mockReset().mockResolvedValue(CONTROLS as never);
    const user = await onExportWithCanvas();
    await waitFor(() => expect(screen.getByTestId('motion-action-place-on-canvas')).not.toHaveAttribute('aria-busy'));
    await user.click(screen.getByTestId('motion-action-place-on-canvas'));
    await user.click(await screen.findByTestId(`motion-canvas-${CANVAS}`));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.calls[0]?.[1]).toMatchObject({ action: { label: t('spaces.webAnimation.viewPlaced') } });
  });
});
