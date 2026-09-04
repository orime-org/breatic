// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The badge that says which of the four states a task row is in (#186 §7.2.1).
 *
 * Each state gets its own semantic colour, and the label is localised — the
 * colour alone cannot say which state this is (WCAG 1.4.1), and four tints of
 * the same shape would be unreadable to anyone who does not see them apart.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { TaskStatusBadge } from '@web/spaces/canvas/tasks/TaskStatusBadge';

afterEach(cleanup);

describe('TaskStatusBadge', () => {
  it('names the state in words, not colour alone', () => {
    render(<TaskStatusBadge status='running' />);

    expect(screen.getByTestId('task-status-badge')).toHaveTextContent(
      'Running',
    );
  });

  it('gives each state its own semantic colour', () => {
    const colours = (['running', 'done', 'failed', 'expired'] as const).map(
      (status) => {
        cleanup();
        render(<TaskStatusBadge status={status} />);
        return screen.getByTestId('task-status-badge').className;
      },
    );

    expect(colours[0]).toContain('status-info');
    expect(colours[1]).toContain('status-success');
    expect(colours[2]).toContain('status-error');
    expect(colours[3]).toContain('status-warning');
  });

  it('reads the same in every state, so a row swapping state does not resize', () => {
    // The rows sit in a narrow panel; a badge whose padding or type size
    // moved with the state would shift everything beside it.
    const shapes = (['running', 'done', 'failed', 'expired'] as const).map(
      (status) => {
        cleanup();
        render(<TaskStatusBadge status={status} />);
        const cls = screen.getByTestId('task-status-badge').className;
        return [
          cls.includes('text-2xs'),
          cls.includes('px-2'),
          cls.includes('rounded-chrome'),
        ];
      },
    );

    for (const shape of shapes) expect(shape).toEqual([true, true, true]);
  });
});
