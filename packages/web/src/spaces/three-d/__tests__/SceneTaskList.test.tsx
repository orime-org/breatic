// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import type { SpaceTask, SpaceTaskList } from '@web/data/api/scene';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';
import type { SceneUploadEntry, SceneUploads } from '@web/spaces/three-d/scene-uploads';
import { SceneTaskList } from '@web/spaces/three-d/SceneTaskList';
import { toast } from '@web/lib/toast';

const api = vi.hoisted(() => ({ listSpaceTasks: vi.fn(), removeSpaceTask: vi.fn() }));
vi.mock('@web/data/api/scene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/scene')>()),
  listSpaceTasks: api.listSpaceTasks,
  removeSpaceTask: api.removeSpaceTask,
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, error: vi.fn() } };
});

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
 * @returns The query client.
 */
function renderList({ uploads = store(), canEdit = true, remoteUploads = {}, onPlace = vi.fn(async () => undefined) }: {
  uploads?: SceneUploads; canEdit?: boolean; remoteUploads?: Record<string, number>; onPlace?: (task: SpaceTask) => Promise<void>;
} = {}): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CollaboratorNamesProvider value={names}>
    <SceneTaskList projectId={P} spaceId={S} userId={ME} canEdit={canEdit} uploads={uploads} remoteUploads={remoteUploads} onPlace={onPlace} />
  </CollaboratorNamesProvider></QueryClientProvider>);
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
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  api.listSpaceTasks.mockReset();
  api.removeSpaceTask.mockReset();
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
    expect(await rowOf('their-failed')).toHaveTextContent('The model failed to upload.');
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
    expect(await screen.findByText('No tasks')).toBeInTheDocument();
  });

  it('retries through the page store, waiting on the row while it starts', async () => {
    api.listSpaceTasks.mockResolvedValue(listed(row({ id: 'failed', status: 'failed', errorMessage: 'aborted' })));
    const uploads = store([{ taskId: 'failed', phase: 'retained' }]);
    renderList({ uploads });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(within(await rowOf('failed')).getByRole('button', { name: 'Retry' }));
    expect(uploads.retry).toHaveBeenCalledWith('failed');
  });

  it('removes a row through the server and says why when it cannot', async () => {
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
