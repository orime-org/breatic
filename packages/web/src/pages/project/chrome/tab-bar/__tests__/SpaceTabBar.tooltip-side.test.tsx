// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// Every tooltip in the Space tab strip opens upward. The tab's own name
// tooltip always did — it takes the Radix default — and the five action
// buttons beside it asked for `bottom`, so the same row answered a hover two
// different ways (user 2026-08-31: 「同栏其余 5 个是错的，它们应该是朝上的」).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  act,
  fireEvent,
  type RenderOptions,
} from '@testing-library/react';
import type * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SpaceTabBar } from '@web/pages/project/chrome/tab-bar/SpaceTabBar';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useUIStore } from '@web/stores';

const render = (ui: React.ReactElement, options?: RenderOptions) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({
    children,
  }: {
    children: React.ReactNode;
  }): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
  return rtlRender(ui, { wrapper: Wrapper, ...options });
};

const SPACES: ProjectSpace[] = [
  { id: 's1', name: 'Main', type: 'canvas' },
  { id: 's2', name: 'Notes', type: 'document' },
];

/** Renders the strip with both action buttons and the reveal control live. */
function setup(): void {
  render(
    <SpaceTabBar
      spaces={SPACES}
      allSpaces={SPACES}
      openTabIds={SPACES.map((s) => s.id)}
      activeSpaceId='s1'
      projectId='p1'
      onActivate={vi.fn()}
      onCreate={vi.fn()}
      onClose={vi.fn()}
      onViewSpace={vi.fn()}
    />,
  );
}

/**
 * Points at one control long enough for its tooltip to open.
 * @param testId - The trigger to hover.
 */
function hover(testId: string): void {
  fireEvent.pointerMove(screen.getByTestId(testId), { pointerType: 'mouse' });
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
}

/** Which side the open tooltips came out on. */
function openSides(): string[] {
  return screen
    .queryAllByRole('tooltip')
    .map((el) => el.getAttribute('data-side') ?? '');
}

describe('the tab strip opens every tooltip upward', () => {
  const realScrollTo = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollTo',
  );

  beforeEach(() => {
    useUIStore.getState().setChatPanelCollapsed(false);
    Element.prototype.scrollTo = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (realScrollTo) {
      Object.defineProperty(Element.prototype, 'scrollTo', realScrollTo);
    } else {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it.each([
    ['the agent toggle', 'agent-toggle'],
    ['the reveal control', 'tabs-reveal-active'],
    ['the new-Space button', 'new-space-button'],
    ['the drawer', 'space-drawer-trigger'],
    ['the activity feed', 'project-activity-trigger'],
  ])('opens %s tooltip above the bar', (_case, testId) => {
    setup();
    hover(testId);
    expect(openSides()).toEqual(['top']);
  });

  it('answers a hover on a tab the same way', () => {
    setup();
    hover('space-tab-s1');
    expect(openSides()).toEqual(['top']);
  });
});
