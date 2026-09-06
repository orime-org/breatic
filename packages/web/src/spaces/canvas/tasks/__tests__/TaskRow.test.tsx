// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One row of the node's task list (#186 §7.1).
 *
 * What a row says and what it offers both come from the state it is in. The
 * two conditional buttons are driven from outside — the File this session
 * holds, and the result the task left behind — so the row can be rendered in
 * every combination without a canvas around it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { NodeTaskEntry } from '@web/data/api/canvas';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import { TaskRow } from '@web/spaces/canvas/tasks/TaskRow';

afterEach(cleanup);

const OPENED = '2026-09-04T10:00:00.000Z';
/** Ten minutes past the instant every task below opened. */
const NOW = Date.parse(OPENED) + 10 * 60 * 1000;

/**
 * A task row entry, defaulted to a running upload.
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
    label: 'holiday.mp4',
    errorMessage: null,
    nodeHistoryId: null,
    content: null,
    coverUrl: null,
    ...over,
  };
}

/**
 * Render one row with a roster that names `u-1`.
 * @param over - Entry overrides.
 * @param props - Row props beyond the entry.
 * @param props.hasRetryFile - Whether this session holds the File.
 * @param props.readOnly - Whether this reader may write.
 * @param props.onReplace - Write the result onto the node.
 * @param props.onRetry - Send the stashed File again.
 * @param props.onDismiss - Drop the row.
 * @param names - Roster, defaulting to one named person.
 */
function renderRow(
  over: Partial<NodeTaskEntry> = {},
  props: {
    hasRetryFile?: boolean;
    readOnly?: boolean;
    onReplace?: (id: string) => void;
    onRetry?: (id: string) => void;
    onDismiss?: (id: string) => void;
  } = {},
  names: Record<string, string> = { 'u-1': 'Ada' },
): void {
  render(
    <CollaboratorNamesProvider
      value={{ resolve: (userId: string) => names[userId] ?? null, members: [] }}
    >
      <TaskRow
        entry={entry(over)}
        now={NOW}
        hasRetryFile={props.hasRetryFile ?? false}
        readOnly={props.readOnly ?? false}
        onReplace={props.onReplace ?? ((): void => {})}
        onRetry={props.onRetry ?? ((): void => {})}
        onDismiss={props.onDismiss ?? ((): void => {})}
      />
    </CollaboratorNamesProvider>,
  );
}

describe('TaskRow', () => {
  it('names the task and who started it', () => {
    renderRow();

    const row = screen.getByTestId('node-task-row');
    expect(row).toHaveTextContent('holiday.mp4');
    expect(row).toHaveTextContent('Ada');
  });

  it('still renders a row whose starter the roster cannot name', () => {
    // A person who left the project is gone from the roster, and their tasks
    // outlive them. Dropping the row would hide a running task.
    renderRow({}, {}, {});

    expect(screen.getByTestId('node-task-row')).toHaveTextContent(
      'holiday.mp4',
    );
  });

  it('counts a running task up and its allowance down', () => {
    renderRow();

    const row = screen.getByTestId('node-task-row');
    // Ten minutes in, twenty of the thirty left.
    expect(row).toHaveTextContent('10:00');
    expect(row).toHaveTextContent('20:00');
  });

  it('offers nothing while it runs', () => {
    renderRow();

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('offers writing the result and finishing when it is done', async () => {
    const onReplace = vi.fn();
    const onDismiss = vi.fn();
    renderRow(
      {
        status: 'done',
        settledAt: '2026-09-04T10:05:00.000Z',
        nodeHistoryId: 'h-1',
        content: 'https://cdn.example/holiday.mp4',
      },
      { onReplace, onDismiss },
    );

    await userEvent.click(screen.getByTestId('task-action-replace'));
    await userEvent.click(screen.getByTestId('task-action-finish'));

    expect(onReplace).toHaveBeenCalledWith('t-1');
    expect(onDismiss).toHaveBeenCalledWith('t-1');
  });

  it('shows why a failure failed', () => {
    renderRow({ status: 'failed', errorMessage: 'The connection dropped.' });

    expect(screen.getByTestId('node-task-row')).toHaveTextContent(
      'The connection dropped.',
    );
  });

  it('says a cause we recognise in the reader’s own language', () => {
    // The row is read by whoever opens the list, so a cause this product
    // knows travels as a code and becomes a sentence here. A sentence written
    // where the failure happened is frozen into whatever language that server
    // or that requester was in.
    renderRow({ status: 'failed', errorMessage: 'over_cap' });

    const row = screen.getByTestId('node-task-row');
    expect(row).toHaveTextContent(
      'This file is larger than uploads are allowed to be.',
    );
    expect(row).not.toHaveTextContent('over_cap');
  });

  it('offers a retry only while this session still holds the File', async () => {
    const onRetry = vi.fn();
    renderRow({ status: 'failed' }, { hasRetryFile: true, onRetry });
    await userEvent.click(screen.getByTestId('task-action-retry'));
    expect(onRetry).toHaveBeenCalledWith('t-1');

    cleanup();
    renderRow({ status: 'failed' }, { hasRetryFile: false });
    expect(screen.queryByTestId('task-action-retry')).toBeNull();
    expect(screen.getByTestId('task-action-clear')).toBeInTheDocument();
  });

  it('says an expired task ran out of time', () => {
    renderRow({ status: 'expired', settledAt: '2026-09-04T10:30:00.000Z' });

    expect(screen.getByTestId('node-task-row')).toHaveTextContent(
      'ran out of time',
    );
  });

  it('says so when an expired task’s result arrived after the verdict', () => {
    renderRow({
      status: 'expired',
      settledAt: '2026-09-04T10:30:00.000Z',
      nodeHistoryId: 'h-1',
      content: 'https://cdn.example/late.mp4',
    });

    const row = screen.getByTestId('node-task-row');
    expect(row).toHaveTextContent('after');
    expect(screen.getByTestId('task-action-replace')).toBeInTheDocument();
  });

  it('shows a running task’s start instant', () => {
    // §7.1 asks a running row for five things, and this is the one that says
    // WHEN. Three uploads on one node otherwise read as three identical rows.
    renderRow({
      status: 'running',
      startedAt: '2026-09-04T18:30:00.000Z',
      settledAt: null,
    });

    const local = new Date('2026-09-04T18:30:00.000Z');
    expect(screen.getByTestId('task-instant')).toHaveTextContent(
      String(local.getDate()),
    );
  });

  it('shows a settled task’s end instant in the reader’s own day', () => {
    // 2026-09-04T18:30Z is still the 4th in UTC+8 and the 4th in UTC-4, so
    // this asserts the date the reader is in rather than a fixed slice of the
    // ISO string.
    renderRow({ status: 'done', settledAt: '2026-09-04T18:30:00.000Z' });

    const local = new Date('2026-09-04T18:30:00.000Z');
    expect(screen.getByTestId('task-instant')).toHaveTextContent(
      String(local.getDate()),
    );
  });
});

describe('a reader who cannot write', () => {
  // The flag makes four hops (canvas → container → panel → row → the rule),
  // and any one of them can be hardcoded to false without a type error.
  it('renders a settled row with no buttons at all', () => {
    renderRow(
      { status: 'done', content: 'https://cdn/x.png', settledAt: '2026-09-04T10:05:00.000Z' },
      { readOnly: true },
    );

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
