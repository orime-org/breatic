import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SpaceTabBar, type SpaceTabSummary } from '../SpaceTabBar';
import { useUIStore } from '@/stores';

const SPACES: SpaceTabSummary[] = [
  { id: 's1', name: 'Main', type: 'canvas' },
  { id: 's2', name: 'Notes', type: 'document' },
];

function setup(overrides: Partial<Parameters<typeof SpaceTabBar>[0]> = {}) {
  const onActivate = vi.fn();
  const onCreate = vi.fn();
  render(
    <SpaceTabBar
      spaces={SPACES}
      activeSpaceId='s1'
      onActivate={onActivate}
      onCreate={onCreate}
      {...overrides}
    />,
  );
  return { onActivate, onCreate };
}

describe('SpaceTabBar', () => {
  beforeEach(() => {
    useUIStore.getState().setChatPanelCollapsed(false);
  });

  it('renders one tab per space', () => {
    setup();
    expect(screen.getByTestId('space-tab-s1')).toBeInTheDocument();
    expect(screen.getByTestId('space-tab-s2')).toBeInTheDocument();
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

  it('agent toggle exposes the right aria-pressed state', () => {
    setup();
    expect(
      screen.getByTestId('agent-toggle').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('+ button is present (NewSpaceDialog trigger)', () => {
    setup();
    expect(screen.getByTestId('new-space-button')).toBeInTheDocument();
  });
});
