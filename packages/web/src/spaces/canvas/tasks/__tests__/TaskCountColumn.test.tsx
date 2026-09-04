// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The four counts that sit outside a node's top-right corner (#186 §7.1).
 *
 * They are the whole of what the shared document says about this node's
 * tasks. Clicking one opens the list filtered to that state, which is the
 * only way the detail behind a number is fetched.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TaskCountColumn } from '@web/spaces/canvas/tasks/TaskCountColumn';

afterEach(cleanup);

const COUNTS = { running: 2, done: 1, failed: 0, expired: 3 };

describe('TaskCountColumn', () => {
  it('reads top to bottom: running, done, failed, expired', () => {
    render(<TaskCountColumn counts={COUNTS} openFor={null} onOpen={vi.fn()} />);

    const shown = screen
      .getAllByTestId(/^task-count-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(shown).toEqual([
      'task-count-running',
      'task-count-done',
      'task-count-failed',
      'task-count-expired',
    ]);
  });

  it('shows each number', () => {
    render(<TaskCountColumn counts={COUNTS} openFor={null} onOpen={vi.fn()} />);

    expect(screen.getByTestId('task-count-running')).toHaveTextContent('2');
    expect(screen.getByTestId('task-count-expired')).toHaveTextContent('3');
  });

  it('stays put when a node carries no task at all', () => {
    // The column is always there, so a node does not resize the moment its
    // first task opens.
    render(
      <TaskCountColumn
        counts={{ running: 0, done: 0, failed: 0, expired: 0 }}
        openFor={null}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getAllByTestId(/^task-count-/)).toHaveLength(4);
  });

  it('dims the states this node has nothing in', () => {
    render(<TaskCountColumn counts={COUNTS} openFor={null} onOpen={vi.fn()} />);

    expect(screen.getByTestId('task-count-failed').className).toContain(
      'opacity-40',
    );
    expect(screen.getByTestId('task-count-running').className).not.toContain(
      'opacity-40',
    );
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

  it('refuses to open a state with nothing in it', () => {
    // An empty list says nothing the zero beside it did not already say.
    const onOpen = vi.fn();
    render(<TaskCountColumn counts={COUNTS} openFor={null} onOpen={onOpen} />);

    const empty = screen.getByTestId('task-count-failed');
    expect(empty).toBeDisabled();
    fireEvent.click(empty);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
