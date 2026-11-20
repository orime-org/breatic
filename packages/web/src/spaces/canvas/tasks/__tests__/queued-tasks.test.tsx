// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A canvas task that waits for a free slot (inner#1968, test spec G-34 and
 * G-38; the confirmed demo's queued page).
 *
 * The counts carry `waiting`, a subset of `running`. The column draws
 * "running − waiting" as running and `waiting` as its own cell, whose tip names
 * the state and says each queued task starts once its starter runs fewer tasks
 * than the limit (`canvas.task.waitReasonEachLimit` with the counts'
 * `waitingLimit`, `waitReasonEach` without one). A waiting row of the task list
 * says why (`canvas.task.waitReasonLimit`), shows no running time and offers
 * Cancel. A node whose only task waits is still busy: it cannot be deleted or
 * filled by a template.
 *
 * Shapes this suite chose where the design names none: the row learns it waits
 * from `entry.waitingSince` and cancels through an `onCancel(taskId)` prop; the
 * tip's limit comes from the counts' `waitingLimit`, the row's from
 * `slotWaitLimit`.
 */

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@web/data/api/canvas', () => ({
  getCachedUnderstandMaxBytes: vi.fn(() => null),
}));

import { setLocale, type NodeTaskCounts, type NodeTaskEntry } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { deriveHandling } from '@web/data/yjs/node-view';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import { NodeTaskPanel } from '@web/spaces/canvas/tasks/NodeTaskPanel';
import { TaskCountColumn } from '@web/spaces/canvas/tasks/TaskCountColumn';
import { TaskRow } from '@web/spaces/canvas/tasks/TaskRow';
import { standsEmpty } from '@web/spaces/canvas/use-node-creation';

// One task waits on this node, so the tip speaks of that one.
const WAIT_TIP = /这条排队任务会在它的发起人同时运行的任务少于上限（\d+ 个）后自动开始/;
const OPENED = '2026-11-15T10:00:00.000Z';
const NOW = Date.parse(OPENED) + 10 * 60 * 1000;

beforeEach(() => setLocale('zh-CN'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

/**
 * A waiting generation row.
 * @param over - What differs.
 * @returns The entry.
 */
function waitingEntry(over: Partial<NodeTaskEntry> = {}): NodeTaskEntry {
  return {
    id: 't-wait',
    projectId: 'p-1',
    spaceId: 's-1',
    nodeId: 'n-1',
    kind: 'generation',
    action: 'generate',
    status: 'running',
    startedByUserId: 'u-1',
    startedAt: OPENED,
    settledAt: null,
    budgetMs: 7_200_000,
    label: 'flux-schnell',
    errorMessage: null,
    nodeHistoryId: null,
    content: null,
    coverUrl: null,
    mediaWidth: null,
    mediaHeight: null,
    duration: null,
    mimeType: null,
    size: null,
    waitingSince: OPENED,
    ...over,
  } as NodeTaskEntry;
}

describe('G-38 the counts column of a node with a waiting task', () => {
  const counts = { running: 3, waiting: 1, waitingLimit: 2, done: 0, failed: 0, expired: 0 } as NodeTaskCounts;

  it('draws running and queued as two cells', () => {
    render(<TooltipProvider><TaskCountColumn counts={counts} endedShown openFor={null} onOpen={vi.fn()} /></TooltipProvider>);
    const shown = screen.getAllByTestId(/^task-count-/).map((el) => el.getAttribute('data-testid'));
    expect(shown).toEqual(['task-count-running', 'task-count-waiting']);
  });

  it('counts the running cell without the waiting ones', async () => {
    render(<TooltipProvider><TaskCountColumn counts={counts} endedShown openFor={null} onOpen={vi.fn()} /></TooltipProvider>);
    await userEvent.hover(screen.getByTestId('task-count-running'));
    expect((await screen.findAllByText('运行中 · 2')).length).toBeGreaterThan(0);
  });

  it('says how many wait and why on the queued cell', async () => {
    render(<TooltipProvider><TaskCountColumn counts={counts} endedShown openFor={null} onOpen={vi.fn()} /></TooltipProvider>);
    await userEvent.hover(screen.getByTestId('task-count-waiting'));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('排队中 · 1');
    expect(tip.textContent).toMatch(WAIT_TIP);
  });
});

describe('G-38 each count opens its own list', () => {
  const counts = { running: 2, waiting: 1, waitingLimit: 2, done: 0, failed: 0, expired: 0 } as NodeTaskCounts;
  const entries = [
    waitingEntry({ id: 't-run', label: 'running-one', waitingSince: null }),
    waitingEntry({ id: 't-wait', label: 'waiting-one' }),
  ];

  /**
   * Render the list for one count.
   * @param status - The count that was clicked.
   */
  function renderList(status: React.ComponentProps<typeof NodeTaskPanel>['status']): void {
    render(
      <TooltipProvider>
        <CollaboratorNamesProvider value={{ resolve: () => 'Ada', members: [] }}>
          <NodeTaskPanel
            status={status}
            entries={entries}
            now={NOW}
            isLoading={false}
            isError={false}
            hasRetryFile={(): boolean => false}
            isWaiting={(): boolean => false}
            readOnly={false}
            onReload={(): void => {}}
            onClose={(): void => {}}
            onView={(): void => {}}
            onRetry={(): void => {}}
            onDismiss={(): void => {}}
            onCancel={(): void => {}}
          />
        </CollaboratorNamesProvider>
      </TooltipProvider>,
    );
  }

  it('opens the queued list from the queued count', async () => {
    const onOpen = vi.fn();
    render(<TooltipProvider><TaskCountColumn counts={counts} endedShown openFor={null} onOpen={onOpen} /></TooltipProvider>);
    await userEvent.click(screen.getByTestId('task-count-waiting'));
    expect(onOpen).toHaveBeenCalledWith('waiting');
  });

  it('marks only the queued count open while the queued list is', () => {
    render(<TooltipProvider><TaskCountColumn counts={counts} endedShown openFor='waiting' onOpen={vi.fn()} /></TooltipProvider>);
    expect(screen.getByTestId('task-count-waiting')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('task-count-running')).toHaveAttribute('aria-pressed', 'false');
  });

  it('titles the queued list queued and lists only the waiting row', () => {
    renderList('waiting');
    expect(screen.getByTestId('node-task-panel-title')).toHaveTextContent('排队中');
    expect(screen.getByTestId('node-task-panel-count')).toHaveTextContent('1');
    const rows = screen.getAllByTestId('node-task-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('排队中');
  });

  it('lists only the rows that run in the running list', () => {
    renderList('running');
    expect(screen.getByTestId('node-task-panel-title')).toHaveTextContent('运行中');
    expect(screen.getByTestId('node-task-panel-count')).toHaveTextContent('1');
    const rows = screen.getAllByTestId('node-task-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('已运行');
  });
});

describe('G-38 a waiting row of the task list', () => {
  /**
   * Render the row as a writer.
   * @param onCancel - What cancelling calls.
   */
  function renderWaiting(onCancel: (id: string) => void): void {
    const props = {
      entry: waitingEntry(),
      now: NOW,
      hasRetryFile: false,
      readOnly: false,
      retrying: false,
      dismissing: false,
      onView: (): void => {},
      onRetry: (): void => {},
      onDismiss: (): void => {},
      onCancel,
    } as React.ComponentProps<typeof TaskRow>;
    render(
      <TooltipProvider>
        <CollaboratorNamesProvider value={{ resolve: () => 'Ada', members: [] }}>
          <TaskRow {...props} />
        </CollaboratorNamesProvider>
      </TooltipProvider>,
    );
  }

  it('says queued, shows no running time and offers cancel', async () => {
    const onCancel = vi.fn();
    renderWaiting(onCancel);
    const row = screen.getByTestId('node-task-row');
    expect(row).toHaveTextContent('排队中');
    expect(row).not.toHaveTextContent('已运行');
    // It has not started, so it names no start time either (demo, waiting row),
    // and the empty cell still pushes Cancel to the right end like every row's buttons.
    expect(screen.queryByTestId('task-instant')).toBeNull();
    expect(screen.getByRole('button', { name: '取消' }).previousElementSibling).toHaveClass('flex-1');
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledWith('t-wait');
  });
});

describe('G-34 a node whose only task waits', () => {
  // Passes before this work: `running` already includes the waiting task, and
  // both gates read `running > 0`.
  const counts = { running: 1, waiting: 1, done: 0, failed: 0, expired: 0 } as NodeTaskCounts;

  it('still handles a task, so it cannot be deleted', () => {
    expect(deriveHandling({ taskCounts: counts })).toBe(true);
  });

  it('does not stand empty, so a template does not fill it', () => {
    const view = { id: 'n-1', type: 'image', data: { taskCounts: counts } } as unknown as CanvasNodeView;
    expect(standsEmpty(view)).toBe(false);
  });
});
