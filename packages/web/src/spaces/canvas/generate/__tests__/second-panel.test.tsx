// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { useSecondPanelSide } from '@web/spaces/canvas/generate/second-panel';

/**
 * Renders a first panel and reports which side the second one opens on.
 * @param props - The hook's arguments.
 * @param props.openKey - Which second panel is open.
 * @param props.maxWidth - The second panel's widest width.
 * @returns The probe.
 */
function Probe({ openKey, maxWidth }: { openKey: string | null; maxWidth: number }): React.JSX.Element {
  const [ref, onLeft] = useSecondPanelSide(openKey, maxWidth);
  return <div ref={ref} data-testid='first' data-left={String(onLeft)} />;
}

/**
 * Places the first panel and sets the window width.
 * @param left - The first panel's left edge.
 * @param right - Its right edge.
 * @param width - The window width.
 */
function place(left: number, right: number, width: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left, right, top: 0, bottom: 0, width: right - left, height: 0, x: left, y: 0, toJSON: () => ({}),
  } as DOMRect);
  vi.stubGlobal('innerWidth', width);
}

const AUDIO = 288;

describe('useSecondPanelSide (#2254)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens on the right when the right has room', () => {
    place(100, 400, 1400);
    render(<Probe openKey='voice' maxWidth={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
  });

  it('opens on the left when only the left has room', () => {
    place(1000, 1300, 1400);
    render(<Probe openKey='voice' maxWidth={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'true');
  });

  it('stays on the right when neither side has room', () => {
    place(100, 1300, 1400);
    render(<Probe openKey='voice' maxWidth={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
  });

  it('measures again when another panel opens', () => {
    place(100, 400, 1400);
    const { rerender } = render(<Probe openKey='voice' maxWidth={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
    place(1000, 1300, 1400);
    rerender(<Probe openKey='items:speakers' maxWidth={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'true');
  });

  it('measures a panel capped at 88vw by its capped width', () => {
    // 500px window: a 520px panel narrows to 440, plus the 8px gap. The left
    // edge at 460 has room for that and the right edge has none.
    place(460, 460, 500);
    render(<Probe openKey='camera' maxWidth={520} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'true');
  });

  it('does not measure while no second panel is open', () => {
    place(1000, 1300, 1400);
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    spy.mockClear();
    render(<Probe openKey={null} maxWidth={AUDIO} />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
  });
});
