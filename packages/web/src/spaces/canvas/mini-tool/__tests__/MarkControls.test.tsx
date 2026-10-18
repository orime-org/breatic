// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup controls in the markup tool's panel (inner#1303 §6.2).
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { MarkControls } from '@web/spaces/canvas/mini-tool/MarkControls';
import { canvasSessions } from '@web/stores/canvas-session';
import { INK } from '@web/stores/drawing-draft';
import type { MarkObject } from '@web/stores/mark-draft';

const RECT: MarkObject = { id: 'a', kind: 'rect', color: INK[0], size: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

/** The session store the controls read. */
const store = () => canvasSessions.of('').getState();

/** Open the markup tool and render its controls. */
function mount(): void {
  store().openMiniTool('n1', 'image.mark', { sourceContent: 'a.png', params: {} });
  render(
    <TooltipProvider>
      <MarkControls />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  canvasSessions.clear();
});

describe('MarkControls', () => {
  it('offers seven tools with select first and pressed', () => {
    mount();
    const ids = ['select', 'arrow', 'rect', 'ellipse', 'line', 'pen', 'text'];
    for (const id of ids) expect(screen.getByTestId(`mini-tool-mark-${id}`)).toBeInTheDocument();
    expect(screen.getByTestId('mini-tool-mark-select')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('mini-tool-mark-pen'));
    expect(store().miniTool?.mark?.tool).toBe('pen');
  });

  it('shares the brush size slider and the six inks, with a colour label', () => {
    mount();
    expect(screen.getByTestId('mini-tool-mark-size-value')).toHaveTextContent('5');
    expect(screen.getByTestId('mini-tool-mark-color-label')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`mini-tool-mark-ink-${INK[3]}`));
    expect(store().miniTool?.mark?.color).toBe(INK[3]);
  });

  it('undoes, redoes and clears the markup', () => {
    mount();
    expect(screen.getByTestId('mini-tool-mark-undo')).toBeDisabled();
    act(() => store().commitMark([RECT]));
    fireEvent.click(screen.getByTestId('mini-tool-mark-clear'));
    expect(store().miniTool?.mark?.objects).toEqual([]);
    fireEvent.click(screen.getByTestId('mini-tool-mark-undo'));
    expect(store().miniTool?.mark?.objects).toEqual([RECT]);
  });

  // §6.6: while the first text is typed, Clear and Undo act on it (leaving the
  // edit first), as Run already does.
  it('lets Clear and Undo act while the first text is being typed', () => {
    mount();
    act(() => {
      store().selectMark('new');
      store().setMarkEditingText('hello');
    });
    expect(screen.getByTestId('mini-tool-mark-clear')).toBeEnabled();
    expect(screen.getByTestId('mini-tool-mark-undo')).toBeEnabled();
  });

  it('leaves the text being edited before a tool, undo or clear acts', () => {
    mount();
    const calls: string[] = [];
    act(() => {
      store().registerMarkChannel({ exitEditing: () => calls.push('exit'), discardSelection: () => undefined });
      store().setMarkEditingText('hi');
    });
    fireEvent.click(screen.getByTestId('mini-tool-mark-rect'));
    expect(calls).toEqual(['exit']);
  });
});
