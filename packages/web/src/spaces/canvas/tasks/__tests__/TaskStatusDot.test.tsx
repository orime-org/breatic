// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The dot that marks which of the four states a task row is in (#186 §7.2.1).
 *
 * The panel is filtered to one state and says which one in its own heading, so
 * every row under that heading is in it. A row repeating the word four times
 * made the badge the loudest thing in the panel while the filename — the only
 * thing telling two rows apart — came second (user 2026-09-06).
 *
 * The word stays in the accessible tree: a reader landing on a row rather than
 * on the heading still hears the state, and the colour is never the only thing
 * carrying it (WCAG 1.4.1).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { TaskStatusDot } from '@web/spaces/canvas/tasks/TaskStatusDot';

afterEach(cleanup);

describe('TaskStatusDot', () => {
  it('keeps the state name in the accessible tree', () => {
    render(<TaskStatusDot status='running' />);

    expect(screen.getByTestId('task-status-dot')).toHaveTextContent('Running');
  });

  it('gives each state its own shape, not only its own colour', () => {
    // Two of the four colours are a hue apart that reads as nothing at this
    // size — dark theme measured failed at rgb(255,149,146) against expired
    // at rgb(255,160,87), the same red channel and eleven apart on green.
    // Shape is the channel that separates them (user 2026-09-06).
    const shapes = (['running', 'done', 'failed', 'expired'] as const).map(
      (status) => {
        cleanup();
        render(<TaskStatusDot status={status} />);
        const icon = screen
          .getByTestId('task-status-dot')
          .querySelector('svg');
        return {
          // The drawing itself, so this compares shapes rather than the
          // classes the component hands every one of them.
          drawing: icon?.innerHTML ?? '',
          className: icon?.getAttribute('class') ?? '',
        };
      },
    );

    expect(new Set(shapes.map((s) => s.drawing)).size).toBe(4);
    // The running one turns, which is how this repo already says "working".
    expect(shapes[0]?.className).toContain('animate-spin');
  });

  it('does not draw the state name, only the dot', () => {
    render(<TaskStatusDot status='failed' />);

    const name = screen.getByText('Failed');
    // `sr-only` is how this repo takes text out of the picture while leaving it
    // in the accessible tree; drawn text would put the word back in the row.
    expect(name.className).toContain('sr-only');
  });

  it('gives each state its own semantic colour', () => {
    const colours = (['running', 'done', 'failed', 'expired'] as const).map(
      (status) => {
        cleanup();
        render(<TaskStatusDot status={status} />);
        return screen.getByTestId('task-status-dot').className;
      },
    );

    expect(colours[0]).toContain('status-info');
    expect(colours[1]).toContain('status-success');
    expect(colours[2]).toContain('status-error');
    expect(colours[3]).toContain('status-warning');
  });

  it('holds the same box in every state, so a row swapping state does not move', () => {
    // The rows sit in a narrow panel. A marker whose size moved with the state
    // would shift the filename beside it every time a task settled.
    const boxes = (['running', 'done', 'failed', 'expired'] as const).map(
      (status) => {
        cleanup();
        render(<TaskStatusDot status={status} />);
        const mark = screen.getByTestId('task-status-dot');
        const icon = mark.querySelector('svg');
        // Every state draws at one size, so a row settling moves nothing
        // beside it.
        return [
          icon?.getAttribute('class')?.includes('size-3') ?? false,
          mark.className.includes('flex-none'),
        ];
      },
    );

    for (const box of boxes) expect(box).toEqual([true, true]);
  });
});
