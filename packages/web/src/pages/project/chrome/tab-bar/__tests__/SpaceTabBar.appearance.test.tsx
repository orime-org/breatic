// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// The three appearance calls the user made on 2026-08-31 after seeing the
// visual advice sheet: a wider gap between tabs, a close key that only takes
// room once the tab is pointed at, and an active tab that reads apart from a
// hovered one on the light ground.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render as rtlRender,
  screen,
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

/** Renders the bar with two tabs, the first one active. */
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

describe('SpaceTabBar appearance', () => {
  const realScrollTo = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollTo',
  );

  beforeEach(() => {
    useUIStore.getState().setChatPanelCollapsed(false);
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    if (realScrollTo) {
      Object.defineProperty(Element.prototype, 'scrollTo', realScrollTo);
    } else {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it('leaves a readable gap between neighbouring tabs', () => {
    setup();
    const row = screen.getByRole('tablist');
    expect(row.style.gap).toBe('var(--space-3)');
  });

  it('gives the close key no width until the tab is pointed at', () => {
    setup();
    const close = screen.getByTestId('space-tab-close-s1');
    // Closed: no box at all, so the name gets the room.
    expect(close.className).toContain('w-0');
    // Pointed at, or reached by keyboard: the box comes back.
    expect(close.className).toContain('group-hover:w-4');
    expect(close.className).toContain('focus-visible:w-4');
  });

  it('paints the active tab a step past the hover fill', () => {
    setup();
    const active = screen.getByRole('tab', { name: /Main/ });
    expect(active.className).toContain('bg-accent-strong');
    const idle = screen.getByRole('tab', { name: /Notes/ });
    expect(idle.className).not.toContain('bg-accent-strong');
  });
});
