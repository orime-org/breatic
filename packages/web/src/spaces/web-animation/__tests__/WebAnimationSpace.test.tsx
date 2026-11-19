// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
import type * as PopoverModule from '@web/components/ui/popover';
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
import { motionListQueryKey } from '@web/spaces/web-animation/use-motion-lists';
import { WebAnimationSpace } from '@web/spaces/web-animation/WebAnimationSpace';
import { useCurrentUserStore } from '@web/stores';
import { useSpaceOpenRequestStore } from '@web/stores/space-open-request';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return {
    ...actual,
    timelineApi: { ...actual.timelineApi, listSpaceExecutions: vi.fn(), getExecution: vi.fn(), previewUrl: vi.fn(), limits: vi.fn(), resolveAsset: vi.fn(), acceptExecution: vi.fn(), cancelExecution: vi.fn() },
  };
});
vi.mock('@hyperframes/player', () => ({}));
vi.mock('@web/data/api/scene', async (importOriginal) => ({ ...await importOriginal<typeof SceneApiModule>(), getSceneControls: vi.fn() }));
vi.mock('@web/spaces/canvas/place-video-on-canvas', () => ({ placeVideoOnCanvas: vi.fn() }));
/** The props every PopoverContent was last rendered with, in render order. */
const popoverContentProps: Array<Record<string, unknown>> = [];
vi.mock('@web/components/ui/popover', async (importOriginal) => {
  const actual = await importOriginal<typeof PopoverModule>();
  const Recorded = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof actual.PopoverContent>>(function Recorded(props, ref) {
    popoverContentProps.push(props as Record<string, unknown>);
    return <actual.PopoverContent ref={ref} {...props} />;
  });
  return { ...actual, PopoverContent: Recorded };
});
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
 * Answer the Space's own lists with these rows: succeeded rows under Completed, the rest under their own tab; the
 * Timeline-made group stays empty.
 * @param succeeded - The succeeded rows, newest first.
 * @param others - The rows in progress and the failed ones.
 * @param others.running - Rows in progress.
 * @param others.failed - Rows that failed, were cancelled or expired.
 * @throws {never} Never.
 */
function listing(succeeded: Array<Record<string, unknown>>, { running = [], failed = [] }: { running?: Array<Record<string, unknown>>; failed?: Array<Record<string, unknown>> } = {}): void {
  const groups: Record<string, Array<Record<string, unknown>>> = { succeeded, running, failed };
  vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(async (params: { group?: string; scope?: string }) => (
    params.scope === 'timeline'
      ? { rows: [], nextCursor: null, totals: { running: 0, succeeded: 0, failed: 0 } }
      : { rows: groups[params.group ?? 'succeeded'] ?? [], nextCursor: null, totals: { running: running.length, succeeded: succeeded.length, failed: failed.length } }
  ) as never);
}

/**
 * Render the Motion Space for an Editor or a Viewer.
 * @param readOnly - Whether the user is a Viewer.
 * @returns The Space's element.
 */
function show(readOnly = false): HTMLElement {
  showInActivity(readOnly);
  return screen.getByTestId('space-region');
}

/**
 * Render the Motion Space inside a React Activity, as the Project page keeps a Space tab that is not shown.
 * @param readOnly - Whether the user is a Viewer.
 * @returns Hides or shows the Space again.
 */
function showInActivity(readOnly = false): (mode: 'visible' | 'hidden') => void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const tree = (mode: 'visible' | 'hidden'): React.JSX.Element => <QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={CONNECTED}>
    <div data-region='space' data-testid='space-region'>
      <React.Activity mode={mode}>
        <WebAnimationSpace projectId={PROJECT} spaceId={SPACE} readOnly={readOnly} myRole={readOnly ? 'viewer' : 'editor'} />
      </React.Activity>
    </div>
  </SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>;
  const { rerender } = render(tree('visible'));
  return (mode) => rerender(tree(mode));
}

/**
 * Seed annotation threads into the Space's document before it opens.
 * @param anchors - Each thread's words, result and time.
 */
async function seedThreads(anchors: Array<{ text: string; executionId: string; timeSeconds: number; point?: { x: number; y: number }; resolved?: boolean }>): Promise<string[]> {
  const store = webAnimationAnnotationStore({ doc: getDoc(docName.webAnimationSpace(PROJECT, SPACE)), readWho: () => ({ role: 'editor', viewerId: 'u1' }) });
  const ids: string[] = [];
  for (const { text, executionId, timeSeconds, point = null, resolved = false } of anchors) {
    const thread = await store.createThread({ initialComment: { body: asCommentBody(text) as never }, metadata: { webAnimationAnchor: { executionId, timeSeconds, point } } });
    if (resolved) await store.resolveThread({ threadId: thread.id });
    ids.push(thread.id);
  }
  return ids;
}

/**
 * Lay the annotation panel out with one thread's item below the fold, and catch where its viewport is scrolled to.
 * @param threadId - The thread whose item lies below the fold.
 * @returns The scrollTo calls, with the element each was made on.
 */
function threadBelowFold(threadId: string): Array<{ on: Element; options: unknown }> {
  const calls: Array<{ on: Element; options: unknown }> = [];
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
    if (this.getAttribute('data-thread-id') === threadId) return DOMRect.fromRect({ x: 0, y: 1000, width: 300, height: 40 });
    if (this.hasAttribute('data-radix-scroll-area-viewport')) return DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 300 });
    return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
  });
  Element.prototype.scrollTo = function scrollTo(this: Element, options?: unknown) { calls.push({ on: this, options }); } as typeof Element.prototype.scrollTo;
  return calls;
}

let realScrollTo: PropertyDescriptor | undefined;
beforeEach(() => { realScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo'); });
afterEach(() => {
  vi.restoreAllMocks();
  if (realScrollTo) Object.defineProperty(Element.prototype, 'scrollTo', realScrollTo);
  else delete (Element.prototype as unknown as Record<string, unknown>).scrollTo;
});

beforeEach(() => {
  _resetForTests();
  listing([]);
  vi.mocked(timelineApi.limits).mockReset().mockResolvedValue(LIMITS as never);
  vi.mocked(timelineApi.previewUrl).mockReset().mockResolvedValue({ url: 'https://preview.example/web-animation/t/index.html' });
});

afterEach(() => {
  cleanup();
  resetRunOnceForTests();
  useCurrentUserStore.setState({ user: null });
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
    await waitFor(() => expect(timelineApi.getExecution).toHaveBeenCalled());
    await user.click(screen.getByTestId('motion-open-executions'));
    await user.click(await screen.findByTestId(`motion-row-${OLDER}`));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', OLDER));
    await openFromPanel(user, 'Older note');
    expect(screen.getByTestId('motion-bottom-bar')).toHaveTextContent('0:02.0 / 0:04.0');
  });

  it('keeps the shown result and its time in the preview while a result is read by id', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    vi.mocked(timelineApi.getExecution).mockReset().mockReturnValue(new Promise(() => {}));
    await seedThreads([{ text: 'Gone note', executionId: GONE, timeSeconds: 3 }, { text: 'Shown note', executionId: NEWER, timeSeconds: 1 }]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await openFromPanel(user, 'Shown note');
    expect(screen.getByTestId('motion-bottom-bar')).toHaveTextContent('0:01.0 / 0:04.0');
    await openFromPanel(user, 'Gone note');
    await waitFor(() => expect(timelineApi.getExecution).toHaveBeenCalled());
    expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER);
    expect(screen.queryByTestId('motion-loading')).toBeNull();
    expect(screen.getByTestId('motion-bottom-bar')).toHaveTextContent('0:01.0 / 0:04.0');
  });

  it('lands on the marker\'s time when it is opened on the shown result after a read that never landed', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    vi.mocked(timelineApi.getExecution).mockReset().mockReturnValue(new Promise(() => {}));
    await seedThreads([{ text: 'Gone note', executionId: GONE, timeSeconds: 3 }, { text: 'Shown note', executionId: NEWER, timeSeconds: 1 }]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await openFromPanel(user, 'Gone note');
    await waitFor(() => expect(timelineApi.getExecution).toHaveBeenCalled());
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

describe('one owner for opening an annotation', () => {
  /**
   * Show NEWER with these threads on it, and the user.
   * @param anchors - The threads.
   * @returns The thread ids and the user.
   */
  async function onNewer(anchors: Parameters<typeof seedThreads>[0]): Promise<{ ids: string[]; user: ReturnType<typeof userEvent.setup> }> {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z'), done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z')]);
    const ids = await seedThreads(anchors);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    return { ids, user: userEvent.setup() };
  }

  /**
   * Open a thread from the annotation panel by its words.
   * @param user - The user.
   * @param text - The thread's words.
   */
  async function fromPanel(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
    if (screen.queryByTestId('motion-panel-annotations') === null) await user.click(screen.getByTestId('motion-open-annotations'));
    await user.click(within(await screen.findByTestId('motion-panel-annotations')).getByRole('button', { name: new RegExp(text) }));
  }

  /**
   * The card's own close button, apart from the panel's.
   * @returns The button.
   */
  function closeCardButton(): HTMLElement {
    const panel = screen.queryByTestId('motion-panel-annotations');
    return screen.getAllByRole('button', { name: t('spaces.webAnimation.closePanel') }).find((button) => panel === null || !panel.contains(button))!;
  }

  /**
   * The open card's reply box.
   * @returns The box.
   */
  async function replyBox(): Promise<HTMLElement> {
    return within(await screen.findByTestId('motion-thread-card')).getByTestId('doc-comment-reply-input');
  }

  it('lists a resolved thread opened from its marker, as the active item', async () => {
    const { ids: [id], user } = await onNewer([{ text: 'Settled note', executionId: NEWER, timeSeconds: 1, resolved: true }]);
    await user.click(await screen.findByTestId(`motion-marker-${id}`));
    const panel = await screen.findByTestId('motion-panel-annotations');
    expect(within(panel).getByTestId(`motion-annotation-${id}`)).toHaveAttribute('aria-current', 'true');
    expect(within(panel).getByTestId('motion-annotations-filter-all')).toHaveAttribute('aria-pressed', 'true');
    expect(within(panel).getByTestId('motion-annotations-filter-all-count')).toHaveTextContent('1');
    // Open has nothing to count, so it shows no chip, as Document's comment filter does.
    expect(within(panel).queryByTestId('motion-annotations-filter-open-count')).toBeNull();
  });

  it('scrolls the panel to a thread below the fold opened from its marker', async () => {
    const anchors = Array.from({ length: 8 }, (_, index) => ({ text: `Note ${index}`, executionId: NEWER, timeSeconds: index * 0.4 }));
    const { ids, user } = await onNewer(anchors);
    const target = ids.at(-1)!;
    const calls = threadBelowFold(target);
    await user.click(await screen.findByTestId(`motion-marker-${target}`));
    const panel = await screen.findByTestId('motion-panel-annotations');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.on).toBe(panel.querySelector('[data-radix-scroll-area-viewport]'));
    expect(calls[0]!.options).toEqual({ top: 1040 - 300, behavior: 'smooth' });
  });

  it('keeps an unsent reply when the card is closed and opened again', async () => {
    const { user } = await onNewer([{ text: 'First note', executionId: NEWER, timeSeconds: 1 }]);
    await fromPanel(user, 'First note');
    await user.type(await replyBox(), 'Half a reply');
    await user.click(closeCardButton());
    expect(screen.queryByTestId('motion-thread-card')).toBeNull();
    await fromPanel(user, 'First note');
    expect(await replyBox()).toHaveValue('Half a reply');
  });

  it('keeps an unsent reply while a thread on a result still being read is open', async () => {
    vi.mocked(timelineApi.getExecution).mockReset().mockReturnValue(new Promise(() => {}));
    const { user } = await onNewer([{ text: 'First note', executionId: NEWER, timeSeconds: 1 }, { text: 'Far note', executionId: '90000000-0000-4000-8000-0000000000d2', timeSeconds: 1 }]);
    await fromPanel(user, 'First note');
    await user.type(await replyBox(), 'Half a reply');
    await fromPanel(user, 'Far note');
    await waitFor(() => expect(timelineApi.getExecution).toHaveBeenCalled());
    await fromPanel(user, 'First note');
    expect(await replyBox()).toHaveValue('Half a reply');
  });

  it('keeps an unsent reply through adding an annotation and cancelling it', async () => {
    const { user } = await onNewer([{ text: 'First note', executionId: NEWER, timeSeconds: 1 }]);
    await fromPanel(user, 'First note');
    await user.type(await replyBox(), 'Half a reply');
    await user.click(screen.getByTestId('motion-action-add-annotation'));
    await screen.findByTestId('motion-annotation-draft');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('motion-annotation-draft')).toBeNull());
    expect(await replyBox()).toHaveValue('Half a reply');
  });

  it('clears the reply once it is sent', async () => {
    const { user } = await onNewer([{ text: 'First note', executionId: NEWER, timeSeconds: 1 }]);
    await fromPanel(user, 'First note');
    await user.type(await replyBox(), 'Done now');
    await user.click(within(screen.getByTestId('motion-thread-card')).getByTestId('doc-comment-reply-save'));
    await waitFor(async () => expect(await replyBox()).toHaveValue(''));
    await user.click(closeCardButton());
    await fromPanel(user, 'First note');
    expect(await replyBox()).toHaveValue('');
  });

  it('closes the open card when an open request shows another result, so it does not come back on returning', async () => {
    const { ids: [id], user } = await onNewer([{ text: 'First note', executionId: NEWER, timeSeconds: 1 }]);
    await fromPanel(user, 'First note');
    await screen.findByTestId('motion-thread-card');
    act(() => useSpaceOpenRequestStore.setState({ state: { status: 'opened', request: { type: 'web_animation', select: OLDER }, spaceId: SPACE } }));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', OLDER));
    expect(within(screen.getByTestId('motion-panel-annotations')).getByTestId(`motion-annotation-${id}`)).not.toHaveAttribute('aria-current');
    await user.click(screen.getByTestId('motion-open-executions'));
    await user.click(await screen.findByTestId(`motion-row-${NEWER}`));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    expect(screen.queryByTestId('motion-thread-card')).toBeNull();
  });

  it('closes the open card when another row is picked, so it does not come back on returning', async () => {
    const { user } = await onNewer([{ text: 'First note', executionId: NEWER, timeSeconds: 1 }]);
    await fromPanel(user, 'First note');
    await screen.findByTestId('motion-thread-card');
    await user.click(screen.getByTestId('motion-open-executions'));
    await user.click(await screen.findByTestId(`motion-row-${OLDER}`));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', OLDER));
    await user.click(screen.getByTestId(`motion-row-${NEWER}`));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    expect(screen.queryByTestId('motion-thread-card')).toBeNull();
  });

  it('scrolls the panel once for an opened thread, not again when the Space is shown again', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    const ids = await seedThreads(Array.from({ length: 8 }, (_, index) => ({ text: `Note ${index}`, executionId: NEWER, timeSeconds: index * 0.4 })));
    const setMode = showInActivity();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const calls = threadBelowFold(ids.at(-1)!);
    await userEvent.setup().click(await screen.findByTestId(`motion-marker-${ids.at(-1)!}`));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => setMode('hidden'));
    act(() => setMode('visible'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(calls).toHaveLength(1);
  });

  it('titles the group of a shown result that is on no loaded page with that result', async () => {
    const FAR = '90000000-0000-4000-8000-0000000000d2';
    vi.mocked(timelineApi.getExecution).mockReset().mockResolvedValue(done(FAR, 'Far logo', '2026-11-14T09:00:00.000000Z') as never);
    const { user } = await onNewer([{ text: 'Far note', executionId: FAR, timeSeconds: 1 }]);
    act(() => useSpaceOpenRequestStore.setState({ state: { status: 'opened', request: { type: 'web_animation', select: FAR }, spaceId: SPACE } }));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', FAR));
    await user.click(screen.getByTestId('motion-open-annotations'));
    const panel = await screen.findByTestId('motion-panel-annotations');
    expect(within(panel).getByRole('heading', { name: 'Far logo' })).toBeInTheDocument();
    expect(within(panel).queryByText(t('spaces.webAnimation.unlistedResult'))).toBeNull();
  });
});

describe('the thread card over the frame', () => {
  /**
   * Show NEWER with one thread marking a point near its bottom-right corner, opened from the panel.
   * @returns The user.
   */
  async function openCard(): Promise<ReturnType<typeof userEvent.setup>> {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    await seedThreads([{ text: 'Corner note', executionId: NEWER, timeSeconds: 0, point: { x: 0.98, y: 0.97 } }]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('motion-open-annotations'));
    await user.click(within(await screen.findByTestId('motion-panel-annotations')).getByRole('button', { name: /Corner note/ }));
    await screen.findByTestId('motion-thread-card');
    return user;
  }

  it('opens through a Popover kept inside the preview area, beside its point', async () => {
    await openCard();
    const props = popoverContentProps.filter((item) => item['data-testid'] === 'motion-thread-card-popover').at(-1)!;
    expect(props.collisionBoundary).toBe(screen.getByTestId('motion-preview-area'));
    expect(props).toMatchObject({ side: 'right', align: 'start' });
    expect(screen.getByTestId('motion-thread-card-popover')).toContainElement(screen.getByTestId('motion-thread-card'));
  });

  it('opens the annotation write box through the same Popover, at the bottom of the frame before a point is marked', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    await userEvent.setup().click(screen.getByTestId('motion-action-add-annotation'));
    const props = popoverContentProps.filter((item) => item['data-testid'] === 'motion-annotation-draft').at(-1)!;
    expect(props.collisionBoundary).toBe(screen.getByTestId('motion-preview-area'));
    // Centred inside the frame's bottom, as the approved demo draws it.
    expect(props).toMatchObject({ side: 'top', align: 'center', sideOffset: 8 });
    expect(screen.getByTestId('motion-annotation-draft')).toContainElement(screen.getByTestId('doc-comment-motion-annotation-input'));
  });

  it('caps both cards at the room the preview area leaves and scrolls what does not fit', async () => {
    const user = await openCard();
    for (const testId of ['motion-thread-card-popover', 'motion-annotation-draft']) {
      if (testId === 'motion-annotation-draft') {
        await user.keyboard('{Escape}');
        await user.click(screen.getByTestId('motion-action-add-annotation'));
      }
      const surface = await screen.findByTestId(testId);
      expect(surface.className).toContain('max-h-[var(--radix-popover-content-available-height)]');
      const viewport = surface.querySelector('[data-radix-scroll-area-viewport]');
      expect(viewport).not.toBeNull();
      expect(viewport!.contains(testId === 'motion-thread-card-popover'
        ? screen.getByTestId('motion-thread-card') : screen.getByTestId('doc-comment-motion-annotation-input'))).toBe(true);
    }
  });

  it('gives each thread opened on the same result a card of its own, scrolled from its top', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    await seedThreads([{ text: 'First note', executionId: NEWER, timeSeconds: 0 }, { text: 'Second note', executionId: NEWER, timeSeconds: 1 }]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('motion-open-annotations'));
    const panel = await screen.findByTestId('motion-panel-annotations');
    await user.click(within(panel).getByRole('button', { name: /First note/ }));
    const first = (await screen.findByTestId('motion-thread-card-popover')).querySelector('[data-radix-scroll-area-viewport]');
    await user.click(within(panel).getByRole('button', { name: /Second note/ }));
    await waitFor(() => expect(within(screen.getByTestId('motion-thread-card')).getByText('Second note')).toBeInTheDocument());
    const second = screen.getByTestId('motion-thread-card-popover').querySelector('[data-radix-scroll-area-viewport]');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('keeps the close button outside what scrolls, so a long thread still closes with the mouse', async () => {
    const user = await openCard();
    const surface = screen.getByTestId('motion-thread-card-popover');
    const close = within(surface).getByRole('button', { name: t('spaces.webAnimation.closePanel') });
    expect(surface.querySelector('[data-radix-scroll-area-viewport]')!.contains(close)).toBe(false);
    await user.click(close);
    expect(screen.queryByTestId('motion-thread-card')).toBeNull();
  });

  it('closes an annotation write box with no words yet from its own close button', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('motion-action-add-annotation'));
    const surface = await screen.findByTestId('motion-annotation-draft');
    await user.click(within(surface).getByRole('button', { name: t('spaces.webAnimation.closePanel') }));
    expect(screen.queryByTestId('motion-annotation-draft')).toBeNull();
    expect(screen.getByTestId('motion-action-add-annotation')).not.toHaveAttribute('aria-pressed', 'true');
  });

  it('asks before its close button throws words away, and puts the user back in the box on Keep writing', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('motion-action-add-annotation'));
    const surface = await screen.findByTestId('motion-annotation-draft');
    await user.type(screen.getByTestId('doc-comment-motion-annotation-input'), 'Logo too small');
    await user.click(within(surface).getByRole('button', { name: t('spaces.webAnimation.closePanel') }));
    await user.click(await screen.findByRole('button', { name: t('spaces.webAnimation.keepWriting') }));
    const input = screen.getByTestId('doc-comment-motion-annotation-input');
    expect(input).toHaveValue('Logo too small');
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('stays open when the user presses outside it', async () => {
    await openCard();
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    fireEvent.pointerDown(screen.getByTestId('motion-bottom-bar'));
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('motion-thread-card')).toBeInTheDocument();
  });

  it('leaves Esc in a reply box with words to the box, which drops the words, and closes on the next Esc', async () => {
    const user = await openCard();
    await user.type(within(screen.getByTestId('motion-thread-card')).getByTestId('doc-comment-reply-input'), 'Half a reply');
    await user.keyboard('{Escape}');
    expect(within(screen.getByTestId('motion-thread-card')).getByTestId('doc-comment-reply-input')).toHaveValue('');
    expect(screen.getByTestId('motion-panel-annotations')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('motion-thread-card')).toBeNull();
    expect(screen.getByTestId('motion-panel-annotations')).toBeInTheDocument();
  });

  it('closes on Esc and leaves the panel open for the next Esc', async () => {
    const user = await openCard();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('motion-thread-card')).toBeNull();
    expect(screen.getByTestId('motion-panel-annotations')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('motion-panel-annotations')).toBeNull();
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
    expect(await screen.findByText(t('spaces.webAnimation.statusLabel'))).toBeInTheDocument();
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
    await waitFor(() => expect(screen.queryByText(t('spaces.webAnimation.statusLabel'))).toBeNull());
  });

  it('scrolls the panel to the original result\'s earliest open annotation below the fold', async () => {
    const ids = await seedThreads(Array.from({ length: 8 }, (_, index) => ({ text: `Note ${index}`, executionId: index === 7 ? OLDER : NEWER, timeSeconds: 1 + index * 0.1 })));
    const calls = threadBelowFold(ids.at(-1)!);
    const user = await onModification();
    await user.click(await screen.findByRole('button', { name: t('spaces.webAnimation.baseWithAnnotations', { base: 'Older logo', count: 1 }) }));
    const panel = await screen.findByTestId('motion-panel-annotations');
    await waitFor(() => expect(calls.filter((call) => call.on === panel.querySelector('[data-radix-scroll-area-viewport]'))).toHaveLength(1));
  });

  it('shows the original result when it has no open annotation', async () => {
    const user = await onModification();
    await user.click(await screen.findByRole('button', { name: 'Older logo' }));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', OLDER));
    expect(screen.queryByTestId('motion-panel-annotations')).toBeNull();
    await waitFor(() => expect(screen.queryByText(t('spaces.webAnimation.statusLabel'))).toBeNull());
  });
});

describe('a preview that cannot load', () => {
  it('says the result a modification starts from is unavailable, and reads it again on Retry', async () => {
    const base = '90000000-0000-4000-8000-0000000000b1';
    const created = done(NEWER, 'Make the dot red', '2026-11-15T09:00:00.000000Z');
    listing([], { failed: [{
      ...created, kind: 'web_animation_modify', status: 'failed', failureReason: 'check', resultSourceVersionId: null, base: { executionId: base, request: 'Gold dot' },
      input: { baseSourceVersionId: '80000000-0000-4000-8000-0000000000b1', instruction: 'Make the dot red', engine: 'deepseek', aspect: '16:9', durationSeconds: 4, fps: { num: 24, den: 1 } },
    }] });
    vi.mocked(timelineApi.getExecution).mockReset().mockRejectedValue(new Error('network'));
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-open-executions'));
    await user.click(within(await screen.findByTestId('motion-panel-executions')).getByRole('tab', { name: new RegExp(t('spaces.webAnimation.failed')) }));
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

describe('the selected result', () => {
  it('stays in the preview after a read of the list no longer holds it', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z'), done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z')]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    // A newer result pushes NEWER off the first page.
    vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(async (params: { group?: string; scope?: string }) => (
      params.group !== 'succeeded' || params.scope === 'timeline'
        ? { rows: [], nextCursor: null, totals: { running: 0, succeeded: 0, failed: 0 } }
        : { rows: [done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z')], nextCursor: 'next', totals: { running: 0, succeeded: 3, failed: 0 } }
    ) as never);
    await refetchFailing();
    expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER);
    expect(screen.queryByTestId('motion-empty')).toBeNull();
  });

  it('keeps the tab the user chose when the Space is shown again', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    const setMode = showInActivity();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('motion-open-executions'));
    const inProgress = within(await screen.findByTestId('motion-panel-executions')).getByRole('tab', { name: new RegExp(t('spaces.webAnimation.inProgress')) });
    await user.click(inProgress);
    expect(inProgress).toHaveAttribute('aria-selected', 'true');
    act(() => setMode('hidden'));
    act(() => setMode('visible'));
    expect(within(screen.getByTestId('motion-panel-executions')).getByRole('tab', { name: new RegExp(t('spaces.webAnimation.inProgress')) })).toHaveAttribute('aria-selected', 'true');
  });

});

/**
 * A row of this Space still in progress.
 * @param id - Its id.
 * @param request - Its prompt.
 * @param phase - The step it is on; null while it waits in the queue.
 * @returns The row.
 */
function inProgressRow(id: string, request: string, phase: string | null = 'writing'): Record<string, unknown> {
  return {
    ...done(id, request, '2026-11-15T10:00:00.000000Z'), status: phase === null ? 'queued' : 'running', phase,
    resultSourceVersionId: null, usageCredits: 0, billedCredits: null, billedAt: null,
  };
}

/**
 * A row of this Space that failed, was cancelled or expired.
 * @param row - The row as it was made.
 * @param status - How it ended.
 * @param reason - Why it failed, for a failure.
 * @returns The row.
 */
function endedRow(row: Record<string, unknown>, status: 'failed' | 'cancelled' | 'expired' = 'failed', reason: string | null = 'validation_failed'): Record<string, unknown> {
  return { ...row, status, failureReason: status === 'failed' ? reason : null, resultSourceVersionId: null, resultAssetId: null };
}

const RUNNING = '90000000-0000-4000-8000-0000000000a1';
const FAILED = '90000000-0000-4000-8000-0000000000f1';

describe('the execution list\'s three tabs', () => {
  it('holds the finished copy of a row the In progress list still answers as running', async () => {
    const finished = done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z');
    listing([finished], { running: [{ ...finished, status: 'running', phase: 'saving', resultSourceVersionId: null }] });
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    expect(await screen.findByTestId('motion-action-modify')).toBeInTheDocument();
    expect(screen.getByTestId('motion-play')).toBeEnabled();
  });

  it('keeps Cancel waiting until the list read after it has answered', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')], { running: [inProgressRow(RUNNING, 'A dot')] });
    show();
    const panel = await (async () => {
      const user = userEvent.setup();
      await user.click(await screen.findByTestId('motion-open-executions'));
      const opened = await screen.findByTestId('motion-panel-executions');
      await user.click(within(opened).getByRole('tab', { name: new RegExp(t('spaces.webAnimation.inProgress')) }));
      return opened;
    })();
    const cancel = within(await within(panel).findByTestId(`motion-row-${RUNNING}`)).getByTestId('motion-cancel');
    vi.mocked(timelineApi.cancelExecution).mockReset().mockImplementation(async () => {
      vi.mocked(timelineApi.listSpaceExecutions).mockReturnValue(new Promise(() => {}));
      return { ...inProgressRow(RUNNING, 'A dot'), status: 'cancelling' } as never;
    });
    fireEvent.click(cancel);
    await waitFor(() => expect(timelineApi.cancelExecution).toHaveBeenCalledOnce());
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(within(panel).getByTestId('motion-cancel')).toHaveAttribute('aria-busy', 'true');
  });

  it('keeps Export waiting until the list read after the accept has answered', async () => {
    const shown = done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z');
    listing([shown]);
    vi.mocked(timelineApi.acceptExecution).mockReset().mockImplementation(async () => {
      vi.mocked(timelineApi.listSpaceExecutions).mockReturnValue(new Promise(() => {}));
      return { row: { ...exported(shown), status: 'queued', resultAssetId: null }, created: true } as never;
    });
    show();
    fireEvent.click(await screen.findByTestId('motion-action-export'));
    await waitFor(() => expect(timelineApi.acceptExecution).toHaveBeenCalledOnce());
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.getByTestId('motion-action-export')).toHaveAttribute('aria-busy', 'true');
  });

  /**
   * Open the execution list on one of its tabs.
   * @param tab - The tab's catalog key.
   * @returns The panel.
   */
  async function openTab(tab: 'completed' | 'inProgress' | 'failed'): Promise<HTMLElement> {
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-open-executions'));
    const panel = await screen.findByTestId('motion-panel-executions');
    await user.click(within(panel).getByRole('tab', { name: new RegExp(t(`spaces.webAnimation.${tab}`)) }));
    return panel;
  }

  it('shows Completed, In progress and Failed in that order, each with its total', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')], { running: [inProgressRow(RUNNING, 'A dot')], failed: [endedRow(done(FAILED, 'A box', '2026-11-15T07:00:00.000000Z'))] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-open-executions'));
    const tabs = within(await screen.findByTestId('motion-panel-executions')).getAllByRole('tab');
    await waitFor(() => expect(tabs.map((tab) => tab.textContent)).toEqual([
      `${t('spaces.webAnimation.completed')}1`, `${t('spaces.webAnimation.inProgress')}1`, `${t('spaces.webAnimation.failed')}1`,
    ]));
  });

  it('shows a row in progress with its step and Cancel, and leaves the preview on a press of the row', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')], { running: [inProgressRow(RUNNING, 'A dot')] });
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const panel = await openTab('inProgress');
    const row = await within(panel).findByTestId(`motion-row-${RUNNING}`);
    expect(row).toHaveTextContent(t('timeline.webAnimation.phase.writing'));
    expect(within(row).getByTestId('motion-cancel')).toHaveTextContent(t('timeline.webAnimation.cancel'));
    await userEvent.setup().click(within(row).getByText('A dot'));
    expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER);
  });

  it('shows a failed row with its reason and Run again, and a cancelled one with its status', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')], {
      failed: [endedRow(done(FAILED, 'A box', '2026-11-15T07:00:00.000000Z')), endedRow(done(RUNNING, 'A dot', '2026-11-15T06:00:00.000000Z'), 'cancelled')],
    });
    show();
    const panel = await openTab('failed');
    const failed = await within(panel).findByTestId(`motion-row-${FAILED}`);
    expect(failed).toHaveTextContent(t('timeline.webAnimation.failure.check'));
    expect(within(failed).getByTestId('motion-retry')).toHaveTextContent(t('timeline.webAnimation.retry'));
    expect(within(panel).getByTestId(`motion-row-${RUNNING}`)).toHaveTextContent(t('timeline.webAnimation.status.cancelled'));
    await userEvent.setup().click(within(failed).getByText('A box'));
    expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER);
  });

  it('opens the creation dialog filled with a failed row\'s request on Run again', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')], { failed: [endedRow(done(FAILED, 'A box', '2026-11-15T07:00:00.000000Z'))] });
    show();
    const panel = await openTab('failed');
    await userEvent.setup().click(within(await within(panel).findByTestId(`motion-row-${FAILED}`)).getByTestId('motion-retry'));
    expect(await screen.findByDisplayValue('A box')).toBeInTheDocument();
  });

  it('says nothing failed on an empty Failed tab', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    const panel = await openTab('failed');
    expect(await within(panel).findByText(t('spaces.webAnimation.emptyFailed'))).toBeInTheDocument();
  });

  it('keeps the preview on the shown result after an accept, opening In progress with the new row marked', async () => {
    const shown = done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z');
    const made = { ...exported(shown), status: 'queued', resultAssetId: null };
    listing([shown]);
    vi.mocked(timelineApi.acceptExecution).mockReset().mockImplementation(async () => {
      listing([shown], { running: [made] });
      return { row: made, created: true } as never;
    });
    show();
    await userEvent.setup().click(await screen.findByTestId('motion-action-export'));
    const panel = await screen.findByTestId('motion-panel-executions');
    await waitFor(() => expect(within(panel).getByRole('tab', { name: new RegExp(t('spaces.webAnimation.inProgress')) })).toHaveAttribute('aria-selected', 'true'));
    expect(await within(panel).findByTestId(`motion-row-${EXPORT}`)).toHaveAttribute('data-marked', 'true');
    expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER);
  });
});

describe('the execution list when a read fails', () => {
  it('keeps the rows when Load more fails, and turns Load more into Retry', async () => {
    const first = done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z');
    vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(async (params: { group?: string; scope?: string; cursor?: string }) => {
      if (params.group !== 'succeeded' || params.scope === 'timeline') return { rows: [], nextCursor: null, totals: { running: 0, succeeded: 0, failed: 0 } } as never;
      if (params.cursor !== undefined) throw new Error('network');
      return { rows: [first], nextCursor: 'next', totals: { running: 0, succeeded: 2, failed: 0 } } as never;
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
      if (params.group !== 'succeeded' || params.scope === 'timeline') return { rows: [], nextCursor: null, totals: { running: 0, succeeded: 0, failed: 0 } } as never;
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

  it('keeps Retry still while only the other list of the tab reads in the background', async () => {
    vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(async (params: { group?: string; scope?: string }) => {
      if (params.group !== 'succeeded' || params.scope === 'timeline') return { rows: [], nextCursor: null, totals: { running: 0, succeeded: 0, failed: 0 } } as never;
      throw new Error('network');
    });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-open-executions'));
    const panel = await screen.findByTestId('motion-panel-executions');
    await within(panel).findByText(t('spaces.webAnimation.listError'));
    vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(() => new Promise(() => {}));
    void clients.at(-1)!.refetchQueries({ queryKey: motionListQueryKey(PROJECT, SPACE, 'timeline', 'succeeded') });
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    // The panel's and the preview's Retry.
    const retries = screen.getAllByRole('button', { name: t('timeline.retry') });
    expect(retries).toHaveLength(2);
    for (const retry of retries) expect(retry).not.toHaveAttribute('aria-busy');
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
      if (params.group !== 'succeeded' || params.scope === 'timeline') return { rows: [], nextCursor: null, totals: { running: 0, succeeded: 0, failed: 0 } } as never;
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

  it('sends one export for two quick presses of Export again on a failed export, which waits for the answer', async () => {
    const source = done(OLDER, 'Older logo', '2026-11-15T08:00:00.000000Z');
    listing([source], { failed: [{ ...exported(source), status: 'failed', failureReason: 'render_failed' }] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('motion-open-executions'));
    await user.click(within(await screen.findByTestId('motion-panel-executions')).getByRole('tab', { name: new RegExp(t('spaces.webAnimation.failed')) }));
    expect(await screen.findByTestId('motion-retry')).toHaveTextContent(t('spaces.webAnimation.reexport'));
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
    // The placement settings are read for the signed-in user.
    useCurrentUserStore.setState({ user: { id: 'u1', name: 'Me', email: 'me@e.com', personalStudio: { name: 'Me', slug: 'me', avatarUrl: null }, membershipTier: 'base' } });
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

describe('annotation marks on the frame and the play bar', () => {
  /**
   * Show NEWER (4 s) with these threads on it.
   * @param anchors - The threads.
   * @returns The thread ids and the user.
   */
  async function onNewer(anchors: Parameters<typeof seedThreads>[0]): Promise<{ ids: string[]; user: ReturnType<typeof userEvent.setup> }> {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    const ids = await seedThreads(anchors);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    return { ids, user: userEvent.setup() };
  }

  it('puts a marker under the slider thumb at its time, which Radix keeps 6px in from either end', async () => {
    const { ids: [id] } = await onNewer([{ text: 'Halfway', executionId: NEWER, timeSeconds: 2 }]);
    const marker = await screen.findByTestId(`motion-marker-${id}`);
    // jsdom normalises the calc() order.
    expect(marker.style.left).toBe('calc(6px + 0.5 * (100% - 12px))');
  });

  it('gives a marker a hit area 24px wide around its 6x10 mark, above the track', async () => {
    const { ids: [id] } = await onNewer([{ text: 'Halfway', executionId: NEWER, timeSeconds: 2 }]);
    const marker = await screen.findByTestId(`motion-marker-${id}`);
    expect(marker).toHaveClass('w-6', 'top-0');
    expect(marker.querySelector('span')).toHaveClass('h-2.5', 'w-1.5');
  });

  it('draws open annotations in the comment colour and resolved ones muted, on the marker and the pin', async () => {
    const { ids: [open, settled] } = await onNewer([
      { text: 'Open note', executionId: NEWER, timeSeconds: 0, point: { x: 0.25, y: 0.5 } },
      { text: 'Settled note', executionId: NEWER, timeSeconds: 0, point: { x: 0.75, y: 0.5 }, resolved: true },
    ]);
    expect((await screen.findByTestId(`motion-marker-${open}`)).querySelector('span')).toHaveClass('bg-comment-outline');
    expect(screen.getByTestId(`motion-marker-${settled}`).querySelector('span')).toHaveClass('bg-muted-foreground');
    expect(screen.getByTestId(`motion-pin-${open}`)).toHaveClass('bg-comment-outline');
    expect(screen.getByTestId(`motion-pin-${settled}`)).toHaveClass('bg-muted-foreground');
  });

  it('anchors a saved pin by its tip, the bottom-left corner, on the point', async () => {
    const { ids: [id] } = await onNewer([{ text: 'Point note', executionId: NEWER, timeSeconds: 0, point: { x: 0.25, y: 0.5 } }]);
    const pin = await screen.findByTestId(`motion-pin-${id}`);
    expect(pin).toHaveClass('rounded-bl-none', '-translate-y-full');
    expect(pin).not.toHaveClass('-translate-x-1/2');
    expect(pin.style.left).toBe('25%');
    expect(pin.style.top).toBe('50%');
  });

  it('draws the point being written as the same pin, and opens the write box 8px clear of it', async () => {
    const { user } = await onNewer([]);
    await user.click(screen.getByTestId('motion-action-add-annotation'));
    const preview = screen.getByTestId('motion-preview');
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 200 }));
    fireEvent.click(preview, { clientX: 100, clientY: 100 });
    const draft = await screen.findByTestId('motion-draft-pin');
    expect(draft).toHaveClass('size-5', 'rounded-bl-none', '-translate-y-full', 'bg-comment-outline');
    expect(draft).not.toHaveClass('-translate-x-1/2');
    expect(draft.style.left).toBe('25%');
    const props = popoverContentProps.filter((item) => item['data-testid'] === 'motion-annotation-draft').at(-1)!;
    expect(props).toMatchObject({ side: 'right', align: 'start', sideOffset: 28 });
  });
});

describe('the bar\'s own look', () => {
  it('draws Play as a filled round button', async () => {
    show();
    expect(await screen.findByTestId('motion-play')).toHaveClass('rounded-full', 'bg-primary');
  });

  it('floats the bar and the panels at the viewport toolbars\' height', async () => {
    show();
    const bar = await screen.findByTestId('motion-bottom-bar');
    expect(bar).toHaveClass('bg-popover', 'shadow');
    expect(bar).not.toHaveClass('bg-card', 'shadow-md');
    await userEvent.setup().click(screen.getByTestId('motion-open-executions'));
    const panel = await screen.findByTestId('motion-panel-executions');
    expect(panel).toHaveClass('bg-popover', 'shadow');
    expect(panel).not.toHaveClass('bg-card', 'shadow-md');
  });
});

describe('the details popover', () => {
  it('names a create by its prompt once, in its heading', async () => {
    listing([done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z')]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    await userEvent.setup().click(screen.getByTestId('motion-details'));
    await screen.findByText(t('spaces.webAnimation.statusLabel'));
    expect(screen.getAllByText('Newer logo')).toHaveLength(1);
    expect(screen.queryByText(t('timeline.webAnimation.dialog.prompt'))).toBeNull();
  });

  it('keeps an export\'s Source row', async () => {
    const source = { ...done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z'), export: { executionId: EXPORT, status: 'succeeded' } };
    listing([source, exported(source)]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('motion-action-view-video'));
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', EXPORT));
    await user.click(screen.getByTestId('motion-details'));
    expect(await screen.findByText(t('spaces.webAnimation.sourceLabel'))).toBeInTheDocument();
  });
});

describe('discarding an annotation', () => {
  it('asks with a destructive Discard', async () => {
    const source = { ...done(NEWER, 'Newer logo', '2026-11-15T09:00:00.000000Z'), export: { executionId: EXPORT, status: 'succeeded' } };
    listing([source, exported(source)]);
    show();
    await waitFor(() => expect(screen.getByTestId('motion-preview')).toHaveAttribute('data-execution-id', NEWER));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('motion-action-add-annotation'));
    await user.type(await screen.findByTestId('doc-comment-motion-annotation-input'), 'Logo too small');
    await user.click(screen.getByTestId('motion-action-view-video'));
    expect(await screen.findByTestId('motion-discard-annotation')).toHaveClass('text-status-error-foreground');
  });
});
