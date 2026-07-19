// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  LeaveProjectGuard,
  shouldBlockLeave,
} from '@web/pages/project/LeaveProjectGuard';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

// Controllable blocker + captured condition — no real router needed.
const blocker = vi.hoisted(() => ({
  state: 'unblocked' as 'unblocked' | 'blocked' | 'proceeding',
  proceed: vi.fn(),
  reset: vi.fn(),
}));
let capturedCondition:
  | ((args: {
      currentLocation: { pathname: string };
      nextLocation: { pathname: string };
    }) => boolean)
  | null = null;

vi.mock('react-router-dom', () => ({
  useBlocker: (fn: typeof capturedCondition) => {
    capturedCondition = fn;
    return blocker;
  },
}));

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));

describe('shouldBlockLeave (#1787)', () => {
  it('blocks only when a front-end op is in flight AND the route changes', () => {
    expect(shouldBlockLeave(true, '/project/p', '/studio')).toBe(true);
    // no front-end op → never blocks (backend AIGC excluded by the store)
    expect(shouldBlockLeave(false, '/project/p', '/studio')).toBe(false);
    // same page → not "leaving"
    expect(shouldBlockLeave(true, '/project/p', '/project/p')).toBe(false);
    expect(shouldBlockLeave(false, '/project/p', '/project/p')).toBe(false);
  });
});

describe('LeaveProjectGuard (#1787)', () => {
  beforeEach(() => {
    blocker.state = 'unblocked';
    blocker.proceed.mockClear();
    blocker.reset.mockClear();
    capturedCondition = null;
    useSpaceOperationsStore.setState({ operations: {} });
  });

  it('renders nothing (no dialog) while not blocked', () => {
    render(<LeaveProjectGuard />);
    expect(screen.queryByText('project.leaveGuard.title')).toBeNull();
  });

  it('the blocker condition reflects the front-end op registry + route change', () => {
    render(<LeaveProjectGuard />);
    expect(capturedCondition).not.toBeNull();
    const args = {
      currentLocation: { pathname: '/project/p' },
      nextLocation: { pathname: '/studio' },
    };
    // No ops → do not block.
    expect(capturedCondition!(args)).toBe(false);
    // Register a front-end op → block the leave.
    useSpaceOperationsStore.getState().register('space-1', 'op-1');
    expect(capturedCondition!(args)).toBe(true);
  });

  it('shows the confirm dialog while blocked; Leave proceeds, Stay resets', () => {
    blocker.state = 'blocked';
    render(<LeaveProjectGuard />);
    expect(screen.getByText('project.leaveGuard.title')).toBeInTheDocument();

    fireEvent.click(screen.getByText('project.leaveGuard.leave'));
    expect(blocker.proceed).toHaveBeenCalledOnce();
    expect(blocker.reset).not.toHaveBeenCalled();
  });

  it('Stay (cancel) resets the blocker, keeping the user in the project', () => {
    blocker.state = 'blocked';
    render(<LeaveProjectGuard />);
    fireEvent.click(screen.getByText('project.leaveGuard.stay'));
    // Cancel closes the dialog → onOpenChange(false) → reset (still blocked).
    expect(blocker.reset).toHaveBeenCalled();
    expect(blocker.proceed).not.toHaveBeenCalled();
  });
});
