// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

import { useFrozenPopoverAnchor } from '@web/spaces/canvas/generate/use-frozen-popover-anchor';

let captured: ReturnType<typeof useFrozenPopoverAnchor> | null = null;

/**
 * Harness that exposes the hook result + a trigger element to snapshot.
 * @returns The trigger button whose rect the hook reads by test id.
 */
function Harness(): React.JSX.Element {
  captured = useFrozenPopoverAnchor('frozen-trigger');
  return <button data-testid='frozen-trigger'>trigger</button>;
}

afterEach(() => {
  captured = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('useFrozenPopoverAnchor — snapshots the trigger rect on open, freezes the anchor', () => {
  it('the anchor rect is the trigger rect captured at the open edge', () => {
    const rect = { left: 12, top: 34, width: 40, height: 8 } as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      rect,
    );
    render(<Harness />);
    expect(captured?.open).toBe(false);

    act(() => captured?.onOpenChange(true));
    expect(captured?.open).toBe(true);
    const anchored = captured?.anchorRef.current.getBoundingClientRect();
    expect(anchored?.left).toBe(12);
    expect(anchored?.top).toBe(34);
  });

  it('keeps the frozen rect even after the trigger later moves (does not re-read)', () => {
    const first = { left: 100, top: 200, width: 40, height: 8 } as DOMRect;
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(first);
    render(<Harness />);
    act(() => captured?.onOpenChange(true)); // snapshot at (100, 200)

    // Trigger "moves" (canvas pan) — the live rect changes, but the frozen
    // anchor must still report the open-time rect.
    spy.mockReturnValue({ left: 999, top: 999, width: 40, height: 8 } as DOMRect);
    const anchored = captured?.anchorRef.current.getBoundingClientRect();
    expect(anchored?.left).toBe(100);
    expect(anchored?.top).toBe(200);
  });

  it('returns an empty rect before the first open (no snapshot yet)', () => {
    render(<Harness />);
    const anchored = captured?.anchorRef.current.getBoundingClientRect();
    expect(anchored?.width).toBe(0);
    expect(anchored?.height).toBe(0);
  });
});
