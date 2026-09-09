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

import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { TaskCountColumn } from '@web/spaces/canvas/tasks/TaskCountColumn';

/**
 * The column under the app's single tooltip provider, which is where the
 * counts hang their per-state tip.
 * @param props - The column's own inputs.
 * @returns The rendered tree.
 */
function renderColumn(props: React.ComponentProps<typeof TaskCountColumn>): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <TaskCountColumn {...props} />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

const COUNTS = { running: 2, done: 1, failed: 0, expired: 3 };

describe('TaskCountColumn', () => {
  it('draws only the states this node has something in, in lifecycle order', () => {
    renderColumn({ counts: COUNTS, openFor: null, onOpen: vi.fn() });

    const shown = screen.getAllByTestId(/^task-count-/).map((el) => el.getAttribute('data-testid'));
    expect(shown).toEqual(['task-count-running', 'task-count-done', 'task-count-expired']);
  });

  it('draws the shape alone, with nothing to read', () => {
    // The icon says which state; how many is what the tip answers, so the
    // cell itself carries no text (user 2026-09-06).
    renderColumn({ counts: COUNTS, openFor: null, onOpen: vi.fn() });

    expect(screen.getByTestId('task-count-running')).toHaveTextContent('');
    expect(screen.getByTestId('task-count-expired')).toHaveTextContent('');
  });

  it('names the state and its count when the pointer rests on it', () => {
    // An icon on its own says nothing to a reader meeting it for the first
    // time, and the number it replaced has to stay reachable.
    renderColumn({ counts: COUNTS, openFor: null, onOpen: vi.fn() });

    return userEvent
      .hover(screen.getByTestId('task-count-expired'))
      .then(() => screen.findAllByText('Expired · 3'))
      .then((found) => {
        expect(found.length).toBeGreaterThan(0);
      });
  });

  it('draws nothing at all on a node that carries no task', () => {
    // A node nobody has uploaded to yet is the common case on a fresh canvas,
    // and a column of four dimmed zeroes on every one of them is the loudest
    // thing on the board while saying nothing.
    renderColumn({
      counts: { running: 0, done: 0, failed: 0, expired: 0 },
      openFor: null,
      onOpen: vi.fn(),
    });

    expect(screen.queryByTestId('node-task-counts')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^task-count-/)).toHaveLength(0);
  });

  it('offers every count it draws, since each one has a list behind it', () => {
    const onOpen = vi.fn();
    renderColumn({ counts: COUNTS, openFor: null, onOpen: onOpen });

    for (const status of ['running', 'done', 'expired'] as const) {
      const cell = screen.getByTestId(`task-count-${status}`);
      expect(cell).toBeEnabled();
      // A count that opens a list has to look like it does; the shared
      // `outline` variant answers a pointer and this one has to as well.
      expect(cell.className).toContain('hover:bg-accent');
    }
  });

  it('keeps the number readable and puts the state on the dot', () => {
    // Light theme measured the state colours at 3.4–4.6 against the cell fills
    // — under the 4.5 a 11px number needs (WCAG 1.4.3). The dot is a graphic
    // and clears its own 3:1 floor at every one of them, so the state rides on
    // the dot and the number takes the foreground (user 2026-09-06).
    renderColumn({ counts: COUNTS, openFor: null, onOpen: vi.fn() });

    const cell = screen.getByTestId('task-count-running');
    expect(cell.className).not.toContain('text-status-info-foreground');
    const mark = cell.querySelector('svg');
    expect(mark?.getAttribute('class')).toContain('text-status-info-foreground');
  });

  it('holds its tint when the pointer crosses the open one', () => {
    // The open cell reads as a badge: the status tint behind it and the same
    // colour on the rim. Without repeating that tint under `hover:` it would
    // take `hover:bg-accent` like any other cell — the two rules merge into
    // different groups, so both survive and the hover one wins.
    renderColumn({ counts: COUNTS, openFor: 'done', onOpen: vi.fn() });

    const cell = screen.getByTestId('task-count-done').className;
    expect(cell).toContain('bg-status-success-bg');
    expect(cell).toContain('hover:bg-status-success-bg');
    // A fill darker than the unopened cells beside it made the one the reader
    // picked read as the least present of the four.
    expect(cell).not.toContain('bg-muted');
  });

  it('gives each state its own shape, the same four the rows use', () => {
    // Two of the four colours read as one thing at this size, so the shape is
    // what tells them apart (user 2026-09-06).
    renderColumn({ counts: COUNTS, openFor: null, onOpen: vi.fn() });

    const drawings = ['running', 'done', 'expired'].map(
      (status) => screen.getByTestId(`task-count-${status}`).querySelector('svg')?.innerHTML ?? '',
    );
    expect(new Set(drawings).size).toBe(3);
    expect(screen.getByTestId('task-count-running').querySelector('svg')?.getAttribute('class')).toContain(
      'animate-spin',
    );
  });

  it('asks for the list of whichever state was clicked', () => {
    const onOpen = vi.fn();
    renderColumn({ counts: COUNTS, openFor: null, onOpen: onOpen });

    fireEvent.click(screen.getByTestId('task-count-done'));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith('done');
  });

  it('closes the list when the open state is clicked again', () => {
    const onOpen = vi.fn();
    renderColumn({ counts: COUNTS, openFor: 'done', onOpen: onOpen });

    fireEvent.click(screen.getByTestId('task-count-done'));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('marks the one whose list is open', () => {
    renderColumn({ counts: COUNTS, openFor: 'done', onOpen: vi.fn() });

    expect(screen.getByTestId('task-count-done')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('task-count-running')).toHaveAttribute('aria-pressed', 'false');
  });
});
