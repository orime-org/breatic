// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useRunAfterMenuClose } from '@web/spaces/canvas/use-run-after-menu-close';

describe('useRunAfterMenuClose', () => {
  it('runs the picked item once the menu has closed and keeps the keyboard from going back', () => {
    const { result } = renderHook(() => useRunAfterMenuClose());
    const action = vi.fn();
    result.current.later(action)?.();
    expect(action).not.toHaveBeenCalled();

    const event = new Event('focusout', { cancelable: true });
    result.current.onCloseAutoFocus(event);
    expect(action).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves the close alone when no deferred item was picked', () => {
    const { result } = renderHook(() => useRunAfterMenuClose());
    const event = new Event('focusout', { cancelable: true });
    result.current.onCloseAutoFocus(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('runs a picked item only for the close that follows it', () => {
    const { result } = renderHook(() => useRunAfterMenuClose());
    const action = vi.fn();
    result.current.later(action)?.();
    result.current.onCloseAutoFocus(new Event('focusout', { cancelable: true }));
    result.current.onCloseAutoFocus(new Event('focusout', { cancelable: true }));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('gives no handler for an item without an action', () => {
    const { result } = renderHook(() => useRunAfterMenuClose());
    expect(result.current.later(undefined)).toBeUndefined();
  });
});
