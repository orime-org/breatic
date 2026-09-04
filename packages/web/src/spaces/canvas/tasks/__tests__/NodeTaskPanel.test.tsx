// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The list that opens beside a node when one of its counts is clicked
 * (#186 §7.1).
 *
 * It shows one state's rows and nothing else: the reader asked for the
 * failures, so the successes are not what they are looking at. The rows come
 * from the server, so the panel has the three states any fetch has, and each
 * of them has to say something the reader can act on.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { NodeTaskEntry } from '@web/data/api/canvas';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import { NodeTaskPanel } from '@web/spaces/canvas/tasks/NodeTaskPanel';

afterEach(cleanup);

const OPENED = '2026-09-04T10:00:00.000Z';
const NOW = Date.parse(OPENED) + 60_000;

/**
 * One task entry.
 * @param over - Fields to override.
 * @returns The entry.
 */
function entry(over: Partial<NodeTaskEntry> = {}): NodeTaskEntry {
  return {
    id: 't-1',
    projectId: 'p-1',
    spaceId: 's-1',
    nodeId: 'n-1',
    kind: 'upload',
    status: 'running',
    startedByUserId: 'u-1',
    startedAt: OPENED,
    settledAt: null,
    budgetMs: 30 * 60 * 1000,
    label: 'first.mp4',
    errorMessage: null,
    nodeHistoryId: null,
    content: null,
    coverUrl: null,
    ...over,
  };
}

/**
 * Render the panel.
 * @param props - Overrides for the panel's props.
 */
function renderPanel(
  props: Partial<React.ComponentProps<typeof NodeTaskPanel>> = {},
): void {
  render(
    <CollaboratorNamesProvider
      value={{ resolve: (): string => 'Ada', members: [] }}
    >
      <NodeTaskPanel
        status='running'
        entries={[entry()]}
        now={NOW}
        isLoading={false}
        isError={false}
        hasRetryFile={(): boolean => false}
        onReload={(): void => {}}
        onClose={(): void => {}}
        onReplace={(): void => {}}
        onRetry={(): void => {}}
        onDismiss={(): void => {}}
        {...props}
      />
    </CollaboratorNamesProvider>,
  );
}

describe('NodeTaskPanel', () => {
  it('shows only the state the reader clicked', () => {
    renderPanel({
      status: 'failed',
      entries: [
        entry({ id: 't-1', status: 'running', label: 'still-going.mp4' }),
        entry({
          id: 't-2',
          status: 'failed',
          label: 'broke.mp4',
          settledAt: '2026-09-04T10:01:00.000Z',
        }),
        entry({
          id: 't-3',
          status: 'done',
          label: 'landed.mp4',
          settledAt: '2026-09-04T10:02:00.000Z',
        }),
      ],
    });

    const rows = screen.getAllByTestId('node-task-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('broke.mp4');
  });

  it('counts what it is showing, not everything the node carries', () => {
    renderPanel({
      status: 'running',
      entries: [
        entry({ id: 't-1', status: 'running' }),
        entry({ id: 't-2', status: 'running' }),
        entry({
          id: 't-3',
          status: 'done',
          settledAt: '2026-09-04T10:02:00.000Z',
        }),
      ],
    });

    expect(screen.getByTestId('node-task-panel-count')).toHaveTextContent('2');
  });

  it('closes when asked', async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });

    await userEvent.click(screen.getByTestId('node-task-panel-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows no rows while the list is still being fetched', () => {
    renderPanel({ isLoading: true, entries: [] });

    expect(screen.queryAllByTestId('node-task-row')).toHaveLength(0);
    expect(screen.getByTestId('node-task-panel-loading')).toBeInTheDocument();
  });

  it('offers another try when the list could not be fetched', async () => {
    const onReload = vi.fn();
    renderPanel({ isError: true, entries: [], onReload });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('node-task-panel-reload'));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('says so when this state has nothing in it', () => {
    // The counts and the list are two reads of the same thing at two
    // different instants, so a count can still say one while the fetch comes
    // back with none.
    renderPanel({ entries: [] });

    expect(screen.getByTestId('node-task-panel-empty')).toBeInTheDocument();
  });

  it('gives each row its own answer about the stashed File', () => {
    renderPanel({
      status: 'failed',
      entries: [
        entry({
          id: 'has-file',
          status: 'failed',
          settledAt: '2026-09-04T10:01:00.000Z',
        }),
        entry({
          id: 'no-file',
          status: 'failed',
          label: 'second.mp4',
          settledAt: '2026-09-04T10:01:00.000Z',
        }),
      ],
      hasRetryFile: (taskId: string): boolean => taskId === 'has-file',
    });

    expect(screen.getAllByTestId('task-action-retry')).toHaveLength(1);
    expect(screen.getAllByTestId('task-action-clear')).toHaveLength(2);
  });
});
