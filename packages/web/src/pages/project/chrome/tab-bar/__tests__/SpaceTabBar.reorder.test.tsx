// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { SpaceTabBar } from '@web/pages/project/chrome/tab-bar/SpaceTabBar';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useUIStore } from '@web/stores';

/**
 * App.tsx supplies both of these at runtime; the drawer and the activity
 * button inside the bar need them here.
 * @param root0 - Wrapper props.
 * @param root0.children - The bar under test.
 * @returns The bar wrapped in the providers it expects.
 */
function Providers({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

const SPACES: ReadonlyArray<ProjectSpace> = [
  { id: 's1', name: 'First', type: 'canvas' },
  { id: 's2', name: 'Second', type: 'canvas' },
  { id: 's3', name: 'Third', type: 'canvas' },
];

/**
 * Render the bar with three tabs and the reorder handler spied on.
 * @returns The spies the assertions read.
 */
function setup(): {
  onActivate: ReturnType<typeof vi.fn>;
  onReorder: ReturnType<typeof vi.fn>;
  } {
  const onActivate = vi.fn();
  const onReorder = vi.fn();
  render(
    <SpaceTabBar
      spaces={SPACES}
      allSpaces={SPACES}
      openTabIds={SPACES.map((s) => s.id)}
      activeSpaceId='s1'
      projectId='p1'
      onActivate={onActivate}
      onCreate={vi.fn()}
      onViewSpace={vi.fn()}
      onReorder={onReorder}
    />,
    { wrapper: Providers },
  );
  return { onActivate, onReorder };
}

describe('SpaceTabBar — the keyboard on a draggable tab', () => {
  beforeEach(() => {
    useUIStore.getState().setChatPanelCollapsed(false);
  });

  // Dragging is pointer-only (design §4.5). dnd-kit ships a keyboard sensor
  // whose start codes are Space and Enter, and registering it takes both keys
  // away from the tab — they are how a keyboard user switches Space today.
  it('switches Space on Enter', async () => {
    const user = userEvent.setup();
    const { onActivate } = setup();

    screen.getByTestId('space-tab-s2').focus();
    await user.keyboard('{Enter}');

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith('s2');
  });

  it('switches Space on the space bar', async () => {
    const user = userEvent.setup();
    const { onActivate } = setup();

    screen.getByTestId('space-tab-s2').focus();
    await user.keyboard('[Space]');

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith('s2');
  });

  it('leaves each tab announced as a tab', () => {
    // useSortable hands back attributes carrying role='button' and tabIndex=0.
    // Spreading them whole would rename every tab in the strip.
    setup();
    for (const space of SPACES) {
      expect(screen.getByTestId(`space-tab-${space.id}`)).toHaveAttribute(
        'role',
        'tab',
      );
    }
  });

  it('does not offer a keyboard drag the strip does not have', () => {
    // dnd-kit ships default screen-reader instructions telling the reader to
    // press space to pick a tab up and use the arrow keys to move it. Space
    // on a tab switches Space (design §4.5), and the text is English in a
    // product that ships five locales.
    setup();
    expect(document.body.textContent).not.toContain('press the space bar');
    expect(document.body.textContent).not.toContain('arrow keys');
  });
});
