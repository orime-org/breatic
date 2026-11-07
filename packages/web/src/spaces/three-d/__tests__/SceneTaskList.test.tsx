// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import type { SpaceTask, SpaceTaskList } from '@web/data/api/scene';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';
import type { SceneUploadEntry, SceneUploads } from '@web/spaces/three-d/scene-uploads';
import { SceneTaskList } from '@web/spaces/three-d/SceneTaskList';
import { toast } from '@web/lib/toast';
import { t } from '@breatic/shared';
import { ApiException } from '@web/data/api/types';
import { failureSentence } from '@web/spaces/canvas/failure-sentence';

const api = vi.hoisted(() => ({ listSpaceTasks: vi.fn(), removeSpaceTask: vi.fn() }));
vi.mock('@web/data/api/scene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/scene')>()),
  listSpaceTasks: api.listSpaceTasks,
  removeSpaceTask: api.removeSpaceTask,
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() } };
});
const request = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiPost: request.post,
}));

const P = 'project-1';
const S = 'space-1';
const ME = 'user-me';
const NOW = Date.parse('2026-11-06T10:00:00.000Z');

/**
 * One row as the server answers it.
 * @param over - What differs from a running upload started a minute ago.
 * @returns The row.
 */
function row(over: Partial<SpaceTask>): SpaceTask {
  return {
    id: 'task', label: 'Lamp', status: 'running', startedByUserId: ME,
    startedAt: new Date(NOW - 60_000).toISOString(), deadlineAt: new Date(NOW - 60_000 + 7_200_000).toISOString(),
    errorMessage: null, assetId: null, ...over,
  };
}

/**
 * A list answer read at NOW on the server.
 * @param tasks - Its rows.
 * @returns The answer.
 */
function listed(...tasks: SpaceTask[]): SpaceTaskList {
  return { serverNow: new Date(NOW).toISOString(), tasks };
}

/**
 * A page store holding the given entries.
 * @param entries - What this page holds.
 * @returns The store.
 */
function store(entries: Partial<SceneUploadEntry>[] = []): SceneUploads & { retry: ReturnType<typeof vi.fn>; reconcile: ReturnType<typeof vi.fn> } {
  const byId = new Map(entries.map((entry) => [entry.taskId!, { projectId: P, spaceId: S, label: 'Lamp', file: new File(['x'], 'lamp.glb'), percent: 0, phase: 'uploading', ...entry } as SceneUploadEntry]));
  return {
    start: vi.fn(),
    retry: vi.fn(async () => ({ kind: 'opened' as const, taskId: 'next' })),
    reconcile: vi.fn(),
    get: (taskId) => byId.get(taskId),
    list: () => [...byId.values()],
    subscribe: () => () => undefined,
    getVersion: () => 0,
  };
}

const names: CollaboratorNames = { resolve: (id: string) => ({ [ME]: 'Me', 'user-zhang': 'Zhang', 'user-li': 'Li' } as Record<string, string>)[id] ?? null } as CollaboratorNames;

/**
 * Render the panel.
 * @param props - Store, edit right, remote progress and place handler.
 * @param props.uploads - The page store.
 * @param props.canEdit - Whether the reader may edit.
 * @param props.remoteUploads - Peers' progress.
 * @param props.onPlace - Place handler.
 * @param props.focusTaskId - The row handed over by a started upload.
 * @param props.onFocused - Told once the handed row has focus.
 * @param props.onRetryGeneration - Opens the generation dialog filled from a generation row.
 * @returns The query client.
 */
function renderList({ uploads = store(), canEdit = true, remoteUploads = {}, onPlace = vi.fn(async () => undefined), focusTaskId = null, onFocused, onRetryGeneration }: {
  uploads?: SceneUploads; canEdit?: boolean; remoteUploads?: Record<string, number>; onPlace?: (task: SpaceTask) => Promise<void>; focusTaskId?: string | null; onFocused?: () => void;
  onRetryGeneration?: (task: SpaceTask) => void;
} = {}): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TooltipProvider><CollaboratorNamesProvider value={names}>
    <SceneTaskList projectId={P} spaceId={S} userId={ME} canEdit={canEdit} uploads={uploads} remoteUploads={remoteUploads} onPlace={onPlace} focusTaskId={focusTaskId} onFocused={onFocused}
      {...(onRetryGeneration === undefined ? {} : { onRetryGeneration })} />
  </CollaboratorNamesProvider></TooltipProvider></QueryClientProvider>);
  return client;
}

/**
 * The rendered row for a task.
 * @param id - The task.
 * @returns Its element.
 */
async function rowOf(id: string): Promise<HTMLElement> {
  return screen.findByTestId(`scene-task-${id}`);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  api.listSpaceTasks.mockReset();
  api.removeSpaceTask.mockReset();
  request.post.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('the 3D Space task list (inner#1690)', () => {
  it('shows each row with its starter and state, the live percent where a peer shares one', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(
      row({ id: 'zhang', startedByUserId: 'user-zhang', label: 'BrainStem' }),
      row({ id: 'li', startedByUserId: 'user-li', label: 'BoxTextured', startedAt: new Date(NOW - 180_000).toISOString() }),
      row({ id: 'done', status: 'done', assetId: 'asset-1', label: 'SimpleSkin' }),
    ));
    renderList({ remoteUploads: { zhang: 78 } });

    expect(await rowOf('zhang')).toHaveTextContent('BrainStem');
    expect(await rowOf('zhang')).toHaveTextContent('Import');
    expect(await rowOf('zhang')).toHaveTextContent('Zhang · Uploading 78%');
    expect(await rowOf('li')).toHaveTextContent('Li · Uploading · 3 min');
    expect(await rowOf('done')).toHaveTextContent('You · Done');
    expect(screen.getAllByTestId(/^scene-task-/).map((element) => element.dataset.testid)).toEqual(['scene-task-zhang', 'scene-task-li', 'scene-task-done']);
  });

  it('names a starter it cannot resolve as a member, so every row says who and what', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(row({ id: 'gone', startedByUserId: 'user-left' })));
    renderList({ remoteUploads: { gone: 7 } });
    expect(await rowOf('gone')).toHaveTextContent('A member · Uploading 7%');
  });

  it('shows a row\'s whole name when the pointer rests on it', async () => {
    const label = 'Cathedral interior with a very long descriptive model name';
    api.listSpaceTasks.mockResolvedValue(listed(row({ id: 'long', label })));
    renderList();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.hover(within(await rowOf('long')).getByText(label));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(label);
  });

  it('shows this page\'s own percent and registration for the uploads it sends', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(row({ id: 'mine' }), row({ id: 'registering' })));
    renderList({ uploads: store([{ taskId: 'mine', phase: 'uploading', percent: 42 }, { taskId: 'registering', phase: 'registering' }]) });
    expect(await rowOf('mine')).toHaveTextContent('You · Uploading 42%');
    expect(await rowOf('registering')).toHaveTextContent('You · Registering');
  });

  it('offers each state only its own actions', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(
      row({ id: 'running' }),
      row({ id: 'done', status: 'done', assetId: 'a' }),
      row({ id: 'mine-failed', status: 'failed', errorMessage: 'aborted' }),
      row({ id: 'their-failed', status: 'failed', errorMessage: 'aborted', startedByUserId: 'user-zhang' }),
      row({ id: 'expired', status: 'expired', errorMessage: 'expired' }),
      row({ id: 'late', status: 'expired', errorMessage: 'expired', assetId: 'b' }),
    ));
    renderList({ uploads: store([{ taskId: 'mine-failed', phase: 'retained' }]) });
    const actions = async (id: string): Promise<string[]> => within(await rowOf(id)).queryAllByRole('button').map((button) => button.textContent ?? '');

    expect(await actions('running')).toEqual([]);
    expect(await actions('done')).toEqual(['Place in scene']);
    expect(await actions('mine-failed')).toEqual(['Retry', 'Remove']);
    expect(await actions('their-failed')).toEqual(['Remove']);
    expect(await actions('expired')).toEqual(['Remove']);
    expect(await actions('late')).toEqual(['Place in scene']);
    expect(await rowOf('expired')).toHaveTextContent('Timed out');
    expect(await rowOf('their-failed')).toHaveTextContent('The upload stopped before it finished.');
  });

  it('shows a read-only member every row and no action', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(row({ id: 'done', status: 'done', assetId: 'a' }), row({ id: 'failed', status: 'failed', errorMessage: 'aborted' })));
    renderList({ canEdit: false, uploads: store([{ taskId: 'failed', phase: 'retained' }]) });
    await rowOf('done');
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('says so when the Space has no tasks', async () => {
    api.listSpaceTasks.mockResolvedValue(listed());
    renderList();
    expect(await screen.findByText('Models you import appear here.')).toBeInTheDocument();
  });

  it('reads the list again for a row this page just opened, then gives that row focus and says so once', async () => {
    api.listSpaceTasks.mockResolvedValueOnce(listed()).mockResolvedValue(listed(row({ id: 'new' })));
    const onFocused = vi.fn();
    renderList({ focusTaskId: 'new', onFocused });
    await waitFor(() => expect(api.listSpaceTasks).toHaveBeenCalledTimes(2));
    await waitFor(async () => expect(await rowOf('new')).toHaveFocus());
    expect(onFocused).toHaveBeenCalledTimes(1);
  });

  it('names each failure by its stored reason', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(
      row({ id: 'big', status: 'failed', errorMessage: 'over_cap' }),
      row({ id: 'odd', status: 'failed', errorMessage: null }),
    ));
    renderList();
    expect(await rowOf('big')).toHaveTextContent('This file is larger than uploads are allowed to be.');
    expect(await rowOf('odd')).toHaveTextContent('The model failed to upload.');
  });

  it('reads the list again after its own retry, whatever the answer', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(row({ id: 'failed', status: 'failed', errorMessage: 'aborted' })));
    const uploads = store([{ taskId: 'failed', phase: 'retained' }]);
    uploads.retry.mockResolvedValueOnce({ kind: 'refused', reason: 'rateLimited' });
    renderList({ uploads });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(within(await rowOf('failed')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.listSpaceTasks).toHaveBeenCalledTimes(2));
  });

  it('retries through the page store, waiting on the row while it starts', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(row({ id: 'failed', status: 'failed', errorMessage: 'aborted' })));
    const uploads = store([{ taskId: 'failed', phase: 'retained' }]);
    renderList({ uploads });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(within(await rowOf('failed')).getByRole('button', { name: 'Retry' }));
    expect(uploads.retry).toHaveBeenCalledWith('failed');
  });

  it('removes a row through the server and says so when it cannot', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(row({ id: 'failed', status: 'failed', errorMessage: 'aborted' })));
    api.removeSpaceTask.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('409'));
    renderList();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(within(await rowOf('failed')).getByRole('button', { name: 'Remove' }));
    expect(api.removeSpaceTask).toHaveBeenCalledWith(P, S, 'failed');
    await user.click(within(await rowOf('failed')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Couldn’t remove the task. Try again.'));
  });

  it('places a finished model, waiting on the row until it is placed', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(row({ id: 'done', status: 'done', assetId: 'a' })));
    const placed = Promise.withResolvers<void>();
    const onPlace = vi.fn(() => placed.promise);
    renderList({ onPlace });
    const button = within(await rowOf('done')).getByRole('button', { name: 'Place in scene' });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(button);
    expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ id: 'done', assetId: 'a' }));
    expect(button).toHaveAttribute('aria-busy', 'true');
    await act(async () => { placed.resolve(); await placed.promise; });
    expect(button).not.toHaveAttribute('aria-busy', 'true');
  });

  it('hands every list it reads to the page store', async () => {
    const answer = listed(row({ id: 'a', status: 'done', assetId: 'x' }));
    api.listSpaceTasks.mockResolvedValue(answer);
    const uploads = store();
    renderList({ uploads });
    await waitFor(() => expect(uploads.reconcile).toHaveBeenCalledWith(S, answer.tasks));
  });

  it('reads the list again once the earliest running row reaches its deadline, timed from the server\'s clock', async () => {
    // The browser runs ten minutes ahead of the server; the deadline is the server's.
    vi.setSystemTime(NOW + 600_000);
    api.listSpaceTasks.mockResolvedValue(listed(row({ id: 'soon', deadlineAt: new Date(NOW + 5_000).toISOString() })));
    renderList();
    await rowOf('soon');
    expect(api.listSpaceTasks).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(api.listSpaceTasks).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(api.listSpaceTasks).toHaveBeenCalledTimes(2);
  });
});

/**
 * A generation row as the server answers it (inner#1691 design 4.3).
 * @param over - What differs from a running text-to-3D row started a minute ago in this Space.
 * @returns The row.
 */
function generation(over: Record<string, unknown>): SpaceTask {
  const { errorMessage: _unused, ...shared } = row({});
  return {
    ...shared, kind: 'generation', origin: 'space', model: { name: 'tripo-h3.1-t23d', displayName: 'Tripo H3.1' }, mode: 't23d',
    prompt: 'A brass desk lamp', negativePrompt: '', params: {}, inputs: [], errorCode: null, label: 'A brass desk lamp', ...over,
  } as unknown as SpaceTask;
}

/**
 * Every toast message shown, whatever its type.
 * @returns The messages, in no particular order across types.
 */
function toasts(): unknown[] {
  return [toast.error, toast.warning, toast.info, toast.success].flatMap((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]));
}

/**
 * The rows the list shows, by id, in order.
 * @returns The ids.
 */
function shownIds(): string[] {
  return screen.queryAllByTestId(/^scene-task-(?!filter)/).map((element) => element.dataset.testid!.replace('scene-task-', ''));
}

/**
 * Pick one filter from the title bar's filter menu.
 * @param user - The user driving the page.
 * @param item - The filter item's test id suffix.
 */
async function filterBy(user: ReturnType<typeof userEvent.setup>, item: string): Promise<void> {
  await user.click(screen.getByTestId('scene-task-filter'));
  await user.click(await screen.findByTestId(`scene-task-filter-${item}`));
}

describe('the 3D Space task list with generation rows (inner#1691)', () => {
  it('shows a generation row\'s input, model, starter, origin, state and elapsed time', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(
      generation({ id: 'text', startedByUserId: 'user-zhang', origin: 'agent', startedAt: new Date(NOW - 180_000).toISOString() }),
      generation({ id: 'image', mode: 'i23d', model: { name: 'tripo-h3.1-multiview', displayName: 'Tripo H3.1' }, prompt: '', label: 'front.png', status: 'done', assetId: 'model-1',
        inputs: [{ assetId: 'a1', url: 'https://cdn.test/a1.png' }, { assetId: 'a2', url: 'https://cdn.test/a2.png' }] }),
      generation({ id: 'broken', status: 'failed', errorCode: 'internal' }),
      row({ id: 'import', status: 'done', assetId: 'x' }),
    ));
    renderList();

    const text = await rowOf('text');
    expect(text).toHaveTextContent('A brass desk lamp');
    expect(text).toHaveTextContent(t('spaces.threeD.taskList.kindGeneration'));
    expect(text).toHaveTextContent('Tripo H3.1 · Zhang · Agent');
    expect(text).toHaveTextContent(t('spaces.threeD.taskList.generatingFor', { minutes: 3 }));

    const image = await rowOf('image');
    expect([...image.querySelectorAll('img')].map((element) => element.getAttribute('src'))).toEqual(['https://cdn.test/a1.png', 'https://cdn.test/a2.png']);
    expect(image).toHaveTextContent(`Tripo H3.1 · You · ${t('spaces.threeD.taskList.originSpace')}`);
    expect(image).toHaveTextContent('Done');

    expect(await rowOf('broken')).toHaveTextContent(failureSentence('internal', t));
    expect(await rowOf('import')).toHaveTextContent('Import');
    expect(await rowOf('import')).not.toHaveTextContent(t('spaces.threeD.taskList.kindGeneration'));
  });

  it('filters by running only, kind, starter and origin, counting the filters set', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(
      row({ id: 'import', status: 'done', assetId: 'x', startedByUserId: 'user-zhang' }),
      generation({ id: 'mine-running' }),
      generation({ id: 'their-failed', status: 'failed', errorCode: 'internal', startedByUserId: 'user-zhang', origin: 'agent' }),
      generation({ id: 'mine-done', status: 'done', assetId: 'm', origin: 'agent' }),
    ));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderList();
    await rowOf('import');
    expect(shownIds()).toEqual(['import', 'mine-running', 'their-failed', 'mine-done']);

    await filterBy(user, 'running');
    expect(shownIds()).toEqual(['mine-running']);
    expect(screen.getByTestId('scene-task-filter-count')).toHaveTextContent(/^1$/);
    await filterBy(user, 'running');
    expect(shownIds()).toEqual(['import', 'mine-running', 'their-failed', 'mine-done']);
    expect(screen.queryByTestId('scene-task-filter-count')).toBeNull();

    await filterBy(user, 'kind-import');
    expect(shownIds()).toEqual(['import']);
    await filterBy(user, 'kind-generation');
    expect(shownIds()).toEqual(['mine-running', 'their-failed', 'mine-done']);
    await filterBy(user, 'starter-me');
    expect(shownIds()).toEqual(['mine-running', 'mine-done']);
    expect(screen.getByTestId('scene-task-filter-count')).toHaveTextContent(/^2$/);
    await filterBy(user, 'kind-all');
    await filterBy(user, 'starter-all');

    await filterBy(user, 'origin-agent');
    expect(shownIds()).toEqual(['their-failed', 'mine-done']);
    await filterBy(user, 'origin-space');
    expect(shownIds()).toEqual(['mine-running']);
  });

  it('offers Retry only to the starter with editing access, and Remove to every editor', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(
      generation({ id: 'mine-failed', status: 'failed', errorCode: 'internal' }),
      generation({ id: 'their-failed', status: 'failed', errorCode: 'internal', startedByUserId: 'user-zhang' }),
      generation({ id: 'mine-expired', status: 'expired' }),
      generation({ id: 'mine-late', status: 'expired', assetId: 'm' }),
    ));
    renderList({ onRetryGeneration: vi.fn() });
    const actions = async (id: string): Promise<string[]> => within(await rowOf(id)).queryAllByRole('button').map((button) => button.textContent ?? '');
    expect(await actions('mine-failed')).toEqual(['Retry', 'Remove']);
    expect(await actions('their-failed')).toEqual(['Remove']);
    expect(await actions('mine-expired')).toEqual(['Retry', 'Remove']);
    expect(await actions('mine-late')).toEqual(['Place in scene']);
  });

  it('offers a read-only starter no Retry on their own failed generation', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(generation({ id: 'mine-failed', status: 'failed', errorCode: 'internal' })));
    renderList({ canEdit: false, onRetryGeneration: vi.fn() });
    expect(within(await rowOf('mine-failed')).queryAllByRole('button')).toEqual([]);
  });

  it('retries a failed generation by opening the dialog from the row, without a check', async () => {
    const failed = generation({ id: 'mine-failed', status: 'failed', errorCode: 'internal', negativePrompt: 'base', params: { texture_quality: 'detailed' } });
    api.listSpaceTasks.mockResolvedValue(listed(failed));
    const onRetryGeneration = vi.fn();
    renderList({ onRetryGeneration });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(within(await rowOf('mine-failed')).getByRole('button', { name: 'Retry' }));
    expect(onRetryGeneration).toHaveBeenCalledWith(failed);
    expect(request.post).not.toHaveBeenCalled();
  });

  it('checks a timed-out generation before retrying: still running says so and opens nothing', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(generation({ id: 'late', status: 'expired' })));
    request.post.mockResolvedValue({ outcome: 'running' });
    const onRetryGeneration = vi.fn();
    renderList({ onRetryGeneration });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(within(await rowOf('late')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(request.post).toHaveBeenCalledWith(`/projects/${P}/three-d/${S}/tasks/late/check`, undefined, undefined));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(onRetryGeneration).not.toHaveBeenCalled();
  });

  it('checks a timed-out generation before retrying: a result found reads the list again and opens nothing', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(generation({ id: 'late', status: 'expired' })));
    request.post.mockResolvedValue({ outcome: 'has_result' });
    const onRetryGeneration = vi.fn();
    renderList({ onRetryGeneration });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(within(await rowOf('late')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.listSpaceTasks).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(onRetryGeneration).not.toHaveBeenCalled();
  });

  it('checks a timed-out generation before retrying: an ended run opens the dialog from the row', async () => {
    const late = generation({ id: 'late', status: 'expired' });
    api.listSpaceTasks.mockResolvedValue(listed(late));
    request.post.mockResolvedValue({ outcome: 'ended' });
    const onRetryGeneration = vi.fn();
    renderList({ onRetryGeneration });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(within(await rowOf('late')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onRetryGeneration).toHaveBeenCalledWith(late));
    expect(request.post).toHaveBeenCalledTimes(1);
  });

  it('says what the server answers when it refuses to remove a timed-out generation, and reads the list again', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(generation({ id: 'late', status: 'expired' })));
    const said = 'This generation is still finishing and may yet produce a result. Try again later.';
    api.removeSpaceTask.mockRejectedValue(new ApiException({ status: 409, message: said, fromServer: true }));
    renderList();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(within(await rowOf('late')).getByRole('button', { name: 'Remove' }));
    expect(api.removeSpaceTask).toHaveBeenCalledWith(P, S, 'late');
    await waitFor(() => expect(toasts()).toEqual([said]));
    await waitFor(() => expect(api.listSpaceTasks).toHaveBeenCalledTimes(2));
  });

  it('says imported and generated models appear here when the Space has no tasks', async () => {
    api.listSpaceTasks.mockResolvedValue(listed());
    renderList();
    expect(await screen.findByText('Models you import or generate appear here.')).toBeInTheDocument();
  });
});
