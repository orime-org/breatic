// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The running count on the 3D Tasks button (inner#2061 design 6): hidden at 0, the number up to 99 and `99+` above,
 * drawn beside the button rather than inside it so a click still lands on the button. The button of the open right
 * panel shows its selected look, the way the overview switch does while the overview shows.
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { SceneViewportToolbar, type ScenePanel } from '@web/spaces/three-d/SceneViewportToolbar';

afterEach(() => {
  cleanup();
});

/**
 * Render the toolbar with a running count.
 * @param runningTasks - The count.
 * @param onPanel - What opening a panel calls.
 * @param openPanel - The panel shown as open.
 * @returns Nothing.
 * @throws {never} Never.
 */
function renderToolbar(runningTasks: number, onPanel: (panel: ScenePanel) => void = () => {}, openPanel: ScenePanel | null = null): void {
  render(<TooltipProvider>
    <SceneViewportToolbar undo={false} redo={false} onHistory={() => {}} hasSelection onPanel={onPanel}
      minimap={false} onMinimap={() => {}} viewfinderHost={() => {}} runningTasks={runningTasks} openPanel={openPanel} />
  </TooltipProvider>);
}

/** Each right panel and its toolbar button. */
const TRIGGERS: ReadonlyArray<[ScenePanel, string]> = [
  ['properties', 'scene-properties-trigger'],
  ['objects', 'scene-objects-trigger'],
  ['tasks', 'scene-tasks-trigger'],
  ['director', 'scene-director-trigger'],
];

describe('SceneViewportToolbar running count', () => {
  it('shows no count when nothing runs', () => {
    renderToolbar(0);
    expect(screen.getByTestId('scene-tasks-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('scene-tasks-count')).toBeNull();
  });

  it.each([
    [1, '1'],
    [99, '99'],
    [100, '99+'],
  ])('shows %i running as %s', (runningTasks, shown) => {
    renderToolbar(runningTasks);
    expect(screen.getByTestId('scene-tasks-count').textContent).toBe(shown);
  });

  it('draws the count beside the button, out of the way of the pointer', () => {
    renderToolbar(3);
    const button = screen.getByTestId('scene-tasks-trigger');
    const count = screen.getByTestId('scene-tasks-count');
    expect(button.contains(count)).toBe(false);
    expect(count.parentElement).toBe(button.parentElement);
    expect(count.className).toContain('pointer-events-none');
  });

  it('keeps the button opening the task panel while a count shows', async () => {
    const onPanel = vi.fn();
    renderToolbar(3, onPanel);
    await userEvent.click(screen.getByTestId('scene-tasks-trigger'));
    expect(onPanel).toHaveBeenCalledWith('tasks');
  });
});

describe('SceneViewportToolbar open panel', () => {
  it.each(TRIGGERS)('shows the %s button selected while its panel is open, and no other', (open) => {
    renderToolbar(3, () => {}, open);
    for (const [panel, testId] of TRIGGERS) {
      expect(screen.getByTestId(testId).className.includes('bg-foreground'), panel).toBe(panel === open);
    }
    expect(screen.getByTestId('scene-tasks-count').textContent).toBe('3');
  });

  it('shows no panel button selected while the right panel is closed', () => {
    renderToolbar(0);
    for (const [, testId] of TRIGGERS) expect(screen.getByTestId(testId).className).not.toContain('bg-foreground');
  });
});
