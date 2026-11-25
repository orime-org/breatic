// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type * as React from 'react';

import { suppressTooltipFocusOpen, useReturnFocus } from '@web/lib/overlay-focus';

describe('suppressTooltipFocusOpen', () => {
  it('stops focus propagation so Radix Tooltip never opens from focus', () => {
    // The handler runs in the capture phase on the trigger button; stopping
    // propagation keeps the focus event from reaching Radix Tooltip's own
    // focus handler, so the tooltip only ever opens on hover — never when an
    // overlay close returns focus to the trigger.
    const event = {
      stopPropagation: vi.fn(),
    } as unknown as React.FocusEvent;
    suppressTooltipFocusOpen(event);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

describe('useReturnFocus', () => {
  /**
   * Open the hook from a focused opener, then close it with focus left where the caller puts it.
   * @param moveFocus - Where focus is when the overlay's close asks for it back.
   * @returns The opener and the element focused elsewhere.
   */
  function closeWith(moveFocus: (elsewhere: HTMLElement) => void): { opener: HTMLElement; elsewhere: HTMLElement } {
    const opener = document.body.appendChild(document.createElement('button'));
    const elsewhere = document.body.appendChild(document.createElement('button'));
    opener.focus();
    const { result } = renderHook(() => useReturnFocus(true));
    moveFocus(elsewhere);
    result.current(new Event('focusScope.autoFocusOnUnmount', { cancelable: true }));
    return { opener, elsewhere };
  }

  it('gives focus back to the opener when it went down with the overlay', () => {
    const { opener } = closeWith(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(opener);
  });

  it('leaves focus where another overlay moved it', () => {
    const { elsewhere } = closeWith((target) => target.focus());
    expect(document.activeElement).toBe(elsewhere);
  });
});
