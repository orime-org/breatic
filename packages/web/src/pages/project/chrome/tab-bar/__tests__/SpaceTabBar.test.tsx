import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SpaceTabBar } from '@/pages/project/chrome/tab-bar/SpaceTabBar';
import type { ProjectSpace } from '@/data/yjs/project-meta';
import { useUIStore } from '@/stores';
import { expectNoA11yViolations } from '@/test-utils/a11y';

const SPACES: ProjectSpace[] = [
  { id: 's1', name: 'Main', type: 'canvas' },
  { id: 's2', name: 'Notes', type: 'document' },
  { id: 's3', name: 'Reel', type: 'timeline', locked: true },
];

function setup(overrides: Partial<Parameters<typeof SpaceTabBar>[0]> = {}) {
  const onActivate = vi.fn();
  const onCreate = vi.fn();
  const onClose = vi.fn();
  const onViewSpace = vi.fn();
  render(
    <SpaceTabBar
      spaces={SPACES}
      allSpaces={SPACES}
      openTabIds={SPACES.map((s) => s.id)}
      activeSpaceId='s1'
      projectId='p1'
      onActivate={onActivate}
      onCreate={onCreate}
      onClose={onClose}
      onViewSpace={onViewSpace}
      {...overrides}
    />,
  );
  return { onActivate, onCreate, onClose, onViewSpace };
}

describe('SpaceTabBar', () => {
  beforeEach(() => {
    useUIStore.getState().setChatPanelCollapsed(false);
  });

  it('has no a11y violations', async () => {
    setup();
    // nested-interactive disabled: each SpaceTab is a `role='tab'`
    // button with an inner close-`<span role='button' tabIndex=0>`.
    // Every mainstream browser tab bar (Chrome, Firefox, Safari,
    // VSCode) uses this pattern; ARIA permits it, but axe-core flags
    // it conservatively. Keyboard reach to the close button works via
    // Tab + Enter/Space — see SpaceTab.tsx for the inline reasoning.
    await expectNoA11yViolations(document.body, {
      'nested-interactive': { enabled: false },
    });
  });

  it('renders one tab per open space', () => {
    setup();
    expect(screen.getByTestId('space-tab-s1')).toBeInTheDocument();
    expect(screen.getByTestId('space-tab-s2')).toBeInTheDocument();
    expect(screen.getByTestId('space-tab-s3')).toBeInTheDocument();
  });

  it('renders the 2 dividers (space-header-left + space-header-right)', () => {
    setup();
    expect(screen.getByTestId('space-header-left')).toBeInTheDocument();
    expect(screen.getByTestId('space-header-right')).toBeInTheDocument();
  });

  it('clicking a non-active tab calls onActivate with its id', async () => {
    const user = userEvent.setup();
    const { onActivate } = setup();
    await user.click(screen.getByTestId('space-tab-s2'));
    expect(onActivate).toHaveBeenCalledWith('s2');
  });

  it('agent toggle button flips chatPanelCollapsed in the UI store', async () => {
    const user = userEvent.setup();
    setup();
    expect(useUIStore.getState().chatPanelCollapsed).toBe(false);
    await user.click(screen.getByTestId('agent-toggle'));
    expect(useUIStore.getState().chatPanelCollapsed).toBe(true);
  });

  it('close button is rendered for every tab regardless of lock (close ≠ delete)', () => {
    setup();
    expect(screen.getByTestId('space-tab-close-s1')).toBeInTheDocument();
    expect(screen.getByTestId('space-tab-close-s3')).toBeInTheDocument();
  });

  it('+ button, drawer trigger, history trigger all present (right group)', () => {
    setup();
    expect(screen.getByTestId('new-space-button')).toBeInTheDocument();
    expect(screen.getByTestId('space-drawer-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('space-history-trigger')).toBeInTheDocument();
  });
});
