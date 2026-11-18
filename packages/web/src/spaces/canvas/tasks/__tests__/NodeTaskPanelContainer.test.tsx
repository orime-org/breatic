// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The task list's own lifecycle (#186 §7.1).
 *
 * The list is one user's fetch; the counts beside it come off the canvas
 * document and move on their own. So the two can disagree, and what keeps them
 * from disagreeing on screen is when this panel asks again.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/data/api/canvas', () => ({
  canvasApi: { listNodeTasks: vi.fn(), dismissNodeTask: vi.fn(), cancelTask: vi.fn() },
  // A failed row's sentence names the ceiling a reading refuses against,
  // which it reads from this module's cache.
  getCachedUnderstandMaxBytes: vi.fn(() => null),
}));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
// The clock is observed rather than run: what matters is whether the panel
// asks for it at all on a list whose rows do not read it.
const ticking = vi.hoisted(() => vi.fn(() => 1_757_116_800_000));
vi.mock('@web/spaces/canvas/tasks/use-ticking-clock', () => ({
  useTickingClock: ticking,
}));
vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { canvasApi } from '@web/data/api/canvas';
import { toast } from '@web/lib/toast';
import { ApiException } from '@web/data/api/types';
import { NodeTaskPanelContainer } from '@web/spaces/canvas/tasks/NodeTaskPanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';
import { useTaskActionsInFlight } from '@web/stores/task-actions-in-flight';
import {
  resetRetryFilesForTests,
  stashRetryFile,
} from '@web/spaces/canvas/upload-retry-files';

type Nodes = React.ComponentProps<typeof NodeTaskPanelContainer>['nodes'];

/** The host node as the container reads it. */
function nodes(failed = 1): Nodes {
  return [
    {
      id: 'target',
      data: { taskCounts: { running: 0, done: 0, failed, expired: 0 } },
    },
  ] as unknown as Nodes;
}

let client: QueryClient;

type OnRetry = React.ComponentProps<typeof NodeTaskPanelContainer>['onRetry'];

/**
 * The tree under test, so a rerender differs from the mount only in the nodes.
 * @param hostNodes - What the canvas holds.
 * @param onRetry - What a Retry press starts.
 * @returns The element to render.
 */
function panel(hostNodes: Nodes, onRetry: OnRetry = vi.fn()): React.JSX.Element {
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ReactFlow
          nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
          edges={[]}
        >
          <NodeTaskPanelContainer
            nodes={hostNodes}
            projectId='p'
            spaceId='s'
            readOnly={false}
            onRetry={onRetry}
          />
        </ReactFlow>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

/**
 * Mount the container in a real ReactFlow, on the app's own cache settings —
 * the app sets `staleTime` to 30 seconds in
 * `app/providers/QueryClientProvider.tsx`.
 * @param hostNodes - What the canvas holds.
 * @param onRetry - What a Retry press starts.
 * @returns The render result, so a case can rerender with other nodes.
 */
function mount(hostNodes: Nodes = nodes(), onRetry?: OnRetry): ReturnType<typeof render> {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  return render(panel(hostNodes, onRetry));
}

beforeEach(() => {
  vi.clearAllMocks();
  useTaskActionsInFlight.setState({ inFlight: new Set() });
  resetRetryFilesForTests();
  vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([]);
  canvasSessions.of('').getState().openTaskPanel('target', 'failed');
});

describe('NodeTaskPanelContainer', () => {
  it('draws nothing once its host node is gone', async () => {
    const view = mount();
    await screen.findByTestId('node-task-panel-title');

    // A collaborator deleted the node this panel hangs on. Closing the panel
    // is the canvas's job (`panel-host-deleted.test.tsx`).
    view.rerender(panel([]));

    await waitFor(() =>
      expect(screen.queryByTestId('node-task-panel-title')).toBeNull(),
    );
  });

  it('closes when the user clears the last row of the state it is showing', async () => {
    // The count cell that opened this panel is drawn only while that state has
    // a task in it, so clearing the last one takes the cell away. Left open,
    // the panel would sit there saying the generic "nothing here right now"
    // with nothing on screen naming which state emptied (user 2026-09-06).
    // The endpoint answers with every task on the node, whatever state it is
    // in; the panel picks out the one state it shows. So a list that still
    // holds rows says nothing about whether the open state emptied.
    vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([
      {
        id: 'task-1',
        status: 'failed',
        action: 'upload',
        label: 'broken-take.mov',
        startedByUserId: 'u1',
        startedAt: '2026-09-06T10:00:00.000Z',
        settledAt: '2026-09-06T10:01:00.000Z',
        budgetMs: 7_200_000,
        errorMessage: 'aborted',
        content: null,
      },
      {
        id: 'task-2',
        status: 'done',
        action: 'upload',
        label: 'poster-final-v3.png',
        startedByUserId: 'u1',
        startedAt: '2026-09-06T09:00:00.000Z',
        settledAt: '2026-09-06T09:01:00.000Z',
        budgetMs: 7_200_000,
        errorMessage: null,
        content: null,
      },
    ] as unknown as Awaited<ReturnType<typeof canvasApi.listNodeTasks>>);
    // Clearing the failed row leaves the node one done task.
    vi.mocked(canvasApi.dismissNodeTask).mockResolvedValue({
      removed: true,
      counts: { running: 0, waiting: 0, done: 1, failed: 0, expired: 0 },
    });

    mount();
    const row = await screen.findByTestId('task-action-clear');
    fireEvent.click(row);

    await waitFor(() =>
      expect(canvasSessions.of('').getState().panelHostId).toBeNull(),
    );
  });

  describe('cancelling a queued task (inner#1968)', () => {
    /**
     * A task waiting for a free slot, as the list answers it.
     * @param id - The task.
     * @returns The row.
     */
    function queued(id: string): Awaited<ReturnType<typeof canvasApi.listNodeTasks>>[number] {
      return {
        id, status: 'running', action: 'generate', label: id, startedByUserId: 'u1',
        startedAt: '2026-09-06T10:00:00.000Z', settledAt: null, budgetMs: 7_200_000,
        errorMessage: null, content: null, waitingSince: '2026-09-06T10:00:00.000Z',
      } as unknown as Awaited<ReturnType<typeof canvasApi.listNodeTasks>>[number];
    }
    const waitingHost = (waiting: number): Nodes =>
      [{ id: 'target', data: { taskCounts: { running: waiting, waiting, done: 0, failed: 0, expired: 0 } } }] as unknown as Nodes;
    /**
     * What the server answers a cancel with: the node's counts after it.
     * @param waiting - How many still wait.
     * @returns The answer.
     */
    const cancelled = (waiting: number): Awaited<ReturnType<typeof canvasApi.cancelTask>> =>
      ({ cancelled: true, counts: { running: waiting, waiting, done: 0, failed: 1, expired: 0 } });

    it('closes once the last queued task is cancelled', async () => {
      canvasSessions.of('').getState().openTaskPanel('target', 'waiting');
      vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([queued('only')]);
      vi.mocked(canvasApi.cancelTask).mockResolvedValue(cancelled(0));
      mount(waitingHost(1));
      fireEvent.click(await screen.findByTestId('task-action-cancel'));
      await waitFor(() => expect(canvasSessions.of('').getState().panelHostId).toBeNull());
    });

    it('stays open while another queued task is left', async () => {
      canvasSessions.of('').getState().openTaskPanel('target', 'waiting');
      vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([queued('first'), queued('second')]);
      vi.mocked(canvasApi.cancelTask).mockResolvedValue(cancelled(1));
      mount(waitingHost(2));
      fireEvent.click((await screen.findAllByTestId('task-action-cancel'))[0]!);
      await waitFor(() => expect(canvasApi.cancelTask).toHaveBeenCalledTimes(1));
      await act(async () => { await Promise.resolve(); });
      expect(canvasSessions.of('').getState().panelHostId).toBe('target');
    });
    it('stays open when the node\'s counts move before the cancel answers, as one queued task is left', async () => {
      canvasSessions.of('').getState().openTaskPanel('target', 'waiting');
      vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([queued('first'), queued('second')]);
      let answer: (value: Awaited<ReturnType<typeof canvasApi.cancelTask>>) => void = () => {};
      vi.mocked(canvasApi.cancelTask).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      const view = mount(waitingHost(2));
      fireEvent.click((await screen.findAllByTestId('task-action-cancel'))[0]!);
      await waitFor(() => expect(canvasApi.cancelTask).toHaveBeenCalledTimes(1));
      // The counts event, carried by the shared document, arrives first.
      vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([queued('second')]);
      view.rerender(panel(waitingHost(1)));
      await waitFor(() => expect(canvasApi.listNodeTasks).toHaveBeenCalledTimes(2));
      await act(async () => { answer(cancelled(1)); await Promise.resolve(); });
      expect(canvasSessions.of('').getState().panelHostId).toBe('target');
    });

    it('takes the cancelled row out of the queued list at once, without reading the list again', async () => {
      canvasSessions.of('').getState().openTaskPanel('target', 'waiting');
      vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([queued('first'), queued('second')]);
      vi.mocked(canvasApi.cancelTask).mockResolvedValue(cancelled(1));
      mount(waitingHost(2));
      fireEvent.click((await screen.findAllByTestId('task-action-cancel'))[0]!);
      await waitFor(() => expect(screen.getAllByTestId('task-action-cancel')).toHaveLength(1));
      expect(canvasApi.listNodeTasks).toHaveBeenCalledTimes(1);
    });

    // A task that started meanwhile is a rule stopping the press, not a failure.
    it('warns with the server\'s sentence when the task started meanwhile, and says anything else the server wrote as an error', async () => {
      canvasSessions.of('').getState().openTaskPanel('target', 'waiting');
      vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([queued('first'), queued('second')]);
      vi.mocked(canvasApi.cancelTask)
        .mockRejectedValueOnce(new ApiException({ status: 409, message: 'It has started.', fromServer: true }))
        .mockRejectedValueOnce(new ApiException({ status: 403, message: 'You can only view this project.', fromServer: true }));
      mount(waitingHost(2));
      const [first, second] = await screen.findAllByTestId('task-action-cancel');
      fireEvent.click(first!);
      await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('It has started.'));
      fireEvent.click(second!);
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('You can only view this project.'));
      expect(toast.error).toHaveBeenCalledTimes(1);
    });

    it('leaves another panel the user opened meanwhile alone when the cancel answers', async () => {
      canvasSessions.of('').getState().openTaskPanel('target', 'waiting');
      vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([queued('only')]);
      let answer: (value: Awaited<ReturnType<typeof canvasApi.cancelTask>>) => void = () => {};
      vi.mocked(canvasApi.cancelTask).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      mount(waitingHost(1));
      fireEvent.click(await screen.findByTestId('task-action-cancel'));
      await waitFor(() => expect(canvasApi.cancelTask).toHaveBeenCalledTimes(1));
      act(() => canvasSessions.of('').getState().openTaskPanel('other', 'failed'));
      await act(async () => { answer(cancelled(0)); await Promise.resolve(); });
      expect(canvasSessions.of('').getState().panelHostId).toBe('other');
    });
  });

  it('asks the server again when the node’s counts move', async () => {
    const view = mount(nodes(1));
    await waitFor(() =>
      expect(canvasApi.listNodeTasks).toHaveBeenCalledTimes(1),
    );

    // The task that was running finished: the server recounted and collab
    // wrote the new numbers onto the node. The rows this panel is showing
    // describe the state before that, down to a countdown still ticking on a
    // task that has ended.
    view.rerender(panel(nodes(2)));

    await waitFor(() =>
      expect(canvasApi.listNodeTasks).toHaveBeenCalledTimes(2),
    );
  });
});

describe('NodeTaskPanelContainer, a key that comes back around', () => {
  it('asks the server again when the counts return to a value they already had', async () => {
    // The key is the counts themselves, and those repeat: a task finishes, the
    // user clears it, and the next upload puts the node back where it began.
    // Served from cache, the list would show the task that was cleared —
    // running, counting up, with no button to get rid of it — and the read
    // that harvests would never reach the server.
    const view = mount(nodes(1));
    await waitFor(() =>
      expect(canvasApi.listNodeTasks).toHaveBeenCalledTimes(1),
    );

    view.rerender(panel(nodes(0)));
    await waitFor(() =>
      expect(canvasApi.listNodeTasks).toHaveBeenCalledTimes(2),
    );

    view.rerender(panel(nodes(1)));
    await waitFor(() =>
      expect(canvasApi.listNodeTasks).toHaveBeenCalledTimes(3),
    );
  });
});

describe('NodeTaskPanelContainer, the clock', () => {
  it('runs only for the list that reads it', async () => {
    // The panel holds one state at a time. A running task on the node means
    // nothing to a user looking at the failures: no row there reads the
    // clock, so nothing should be re-rendering once a second.
    vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([
      {
        id: 't-1',
        projectId: 'p',
        spaceId: 's',
        nodeId: 'target',
        kind: 'upload',
        action: 'upload',
        status: 'running',
        startedByUserId: 'u-1',
        startedAt: '2026-09-06T00:00:00.000Z',
        settledAt: null,
        budgetMs: 1_800_000,
        label: 'clip.mp4',
        errorMessage: null,
        nodeHistoryId: null,
        content: null,
        coverUrl: null,
        mediaWidth: null,
        mediaHeight: null,
        duration: null,
        mimeType: null,
        size: null,
      },
    ]);
    mount(nodes(1));

    await waitFor(() =>
      expect(canvasApi.listNodeTasks).toHaveBeenCalledTimes(1),
    );
    // The running row has arrived by the time the panel renders it again.
    await waitFor(() => expect(ticking.mock.calls.length).toBeGreaterThan(1));
    expect(ticking).not.toHaveBeenCalledWith(true);
  });
});

/** One failed upload on the host, the row a Retry or a Clear acts on. */
const FAILED_ROW = [
  {
    id: 'task-1',
    status: 'failed',
    action: 'upload',
    label: 'broken-take.mov',
    startedByUserId: 'u1',
    startedAt: '2026-09-06T10:00:00.000Z',
    settledAt: '2026-09-06T10:01:00.000Z',
    budgetMs: 7_200_000,
    errorMessage: 'aborted',
    content: null,
  },
] as unknown as Awaited<ReturnType<typeof canvasApi.listNodeTasks>>;

/** A promise and the two ways a case settles it. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * A promise the case settles by hand.
 * @returns The promise and its two exits.
 */
function deferred(): Deferred {
  let resolve: () => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('NodeTaskPanelContainer, a press waiting for the server', () => {
  beforeEach(() => {
    vi.mocked(canvasApi.listNodeTasks).mockResolvedValue(FAILED_ROW);
    stashRetryFile('p', 's', 'task-1', new File(['x'], 'broken-take.mov'));
  });

  it.each([
    ['delivered', true],
    ['failed', false],
  ] as const)('waits on Retry until the re-send is %s', async (_outcome, delivered) => {
    const upload = deferred();
    mount(nodes(), vi.fn(() => upload.promise));
    const retry = await screen.findByTestId('task-action-retry');
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toHaveAttribute('aria-busy', 'true'));
    expect(retry).toHaveAttribute('aria-disabled', 'true');

    await act(async () => {
      if (delivered) upload.resolve();
      else upload.reject(new Error('upload failed'));
      await Promise.resolve();
    });

    await waitFor(() => expect(retry).not.toHaveAttribute('aria-busy'));
  });

  it('still waits on Retry after the panel is closed and opened again', async () => {
    const upload = deferred();
    const onRetry = vi.fn(() => upload.promise);
    const view = mount(nodes(), onRetry);
    fireEvent.click(await screen.findByTestId('task-action-retry'));
    await waitFor(() =>
      expect(screen.getByTestId('task-action-retry')).toHaveAttribute('aria-busy', 'true'),
    );

    view.unmount();
    mount(nodes(), onRetry);

    const again = await screen.findByTestId('task-action-retry');
    expect(again).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      upload.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(again).not.toHaveAttribute('aria-busy'));
  });

  it('keeps Retry spinning on its own upload when Clear is pressed meanwhile', async () => {
    const upload = deferred();
    const request = deferred();
    vi.mocked(canvasApi.dismissNodeTask).mockReturnValue(
      request.promise as unknown as ReturnType<typeof canvasApi.dismissNodeTask>,
    );
    mount(nodes(), vi.fn(() => upload.promise));
    const retry = await screen.findByTestId('task-action-retry');
    const clear = screen.getByTestId('task-action-clear');
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toHaveAttribute('aria-busy', 'true'));
    expect(clear).not.toHaveAttribute('aria-busy');

    fireEvent.click(clear);
    expect(canvasApi.dismissNodeTask).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(clear).toHaveAttribute('aria-busy', 'true'));
    expect(retry).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      upload.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(retry).not.toHaveAttribute('aria-busy'));
    expect(clear).toHaveAttribute('aria-busy', 'true');
  });

  it('waits on Clear until the server takes it, and the row leaves', async () => {
    const request = deferred();
    vi.mocked(canvasApi.dismissNodeTask).mockReturnValue(
      request.promise.then(() => ({ removed: true, counts: { running: 0, waiting: 0, done: 0, failed: 0, expired: 0 } })),
    );
    mount();
    const clear = await screen.findByTestId('task-action-clear');
    fireEvent.click(clear);
    await waitFor(() => expect(clear).toHaveAttribute('aria-busy', 'true'));

    await act(async () => {
      request.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.queryByTestId('task-action-clear')).toBeNull(),
    );
    expect(useTaskActionsInFlight.getState().inFlight.size).toBe(0);
  });

  it('stops waiting on Clear when the server refuses it, and keeps the row', async () => {
    const request = deferred();
    vi.mocked(canvasApi.dismissNodeTask).mockReturnValue(
      request.promise as unknown as ReturnType<typeof canvasApi.dismissNodeTask>,
    );
    mount();
    const clear = await screen.findByTestId('task-action-clear');
    fireEvent.click(clear);
    await waitFor(() => expect(clear).toHaveAttribute('aria-busy', 'true'));

    await act(async () => {
      request.reject(new Error('refused'));
      await Promise.resolve();
    });

    await waitFor(() => expect(clear).not.toHaveAttribute('aria-busy'));
    expect(clear).toBeInTheDocument();
  });
});
