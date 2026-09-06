// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The counts that sit outside a node's top-right corner (#186 §7.1).
 *
 * They are the whole of what the shared document says about this node's
 * tasks. Clicking one opens the list filtered to that state, which is the
 * only way the detail behind a number is fetched.
 *
 * A state this node has nothing in draws nothing: zero is not a value the
 * column renders, it is the absence of that count (user 2026-09-06). The ones
 * that are there keep their lifecycle order, so a reader who has seen the
 * column before knows which is which without reading the numbers.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TaskCountColumn } from '@web/spaces/canvas/tasks/TaskCountColumn';

afterEach(cleanup);

const COUNTS = { running: 2, done: 1, failed: 0, expired: 3 };

describe('TaskCountColumn', () => {
  it('draws only the states this node has something in, in lifecycle order', () => {
    render(<TaskCountColumn counts={COUNTS} openFor={null} onOpen={vi.fn()} />);

    const shown = screen
      .getAllByTestId(/^task-count-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(shown).toEqual([
      'task-count-running',
      'task-count-done',
      'task-count-expired',
    ]);
  });

  it('shows each number', () => {
    render(<TaskCountColumn counts={COUNTS} openFor={null} onOpen={vi.fn()} />);

    expect(screen.getByTestId('task-count-running')).toHaveTextContent('2');
    expect(screen.getByTestId('task-count-expired')).toHaveTextContent('3');
  });

  it('draws nothing at all on a node that carries no task', () => {
    // A node nobody has uploaded to yet is the common case on a fresh canvas,
    // and a column of four dimmed zeroes on every one of them is the loudest
    // thing on the board while saying nothing.
    render(
      <TaskCountColumn
        counts={{ running: 0, done: 0, failed: 0, expired: 0 }}
        openFor={null}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('node-task-counts')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^task-count-/)).toHaveLength(0);
  });

  it('offers every count it draws, since each one has a list behind it', () => {
    const onOpen = vi.fn();
    render(<TaskCountColumn counts={COUNTS} openFor={null} onOpen={onOpen} />);

    for (const status of ['running', 'done', 'expired'] as const) {
      const cell = screen.getByTestId(`task-count-${status}`);
      expect(cell).toBeEnabled();
      // A count that opens a list has to look like it does; the shared
      // `outline` variant answers a pointer and this one has to as well.
      expect(cell.className).toContain('hover:bg-accent');
    }
  });

  it('asks for the list of whichever state was clicked', () => {
    const onOpen = vi.fn();
    render(<TaskCountColumn counts={COUNTS} openFor={null} onOpen={onOpen} />);

    fireEvent.click(screen.getByTestId('task-count-done'));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith('done');
  });

  it('closes the list when the open state is clicked again', () => {
    const onOpen = vi.fn();
    render(<TaskCountColumn counts={COUNTS} openFor='done' onOpen={onOpen} />);

    fireEvent.click(screen.getByTestId('task-count-done'));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('marks the one whose list is open', () => {
    render(<TaskCountColumn counts={COUNTS} openFor='done' onOpen={vi.fn()} />);

    expect(screen.getByTestId('task-count-done')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('task-count-running')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
