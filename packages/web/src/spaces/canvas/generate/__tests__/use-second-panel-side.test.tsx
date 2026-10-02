// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { useSecondPanelSide } from '@web/spaces/canvas/generate/use-second-panel-side';

/**
 * Renders a first panel and reports which side the second one opens on.
 * @param props - The hook's arguments.
 * @param props.openKey - Which second panel is open.
 * @param props.span - How far the second panel reaches.
 * @returns The probe.
 */
function Probe({ openKey, span }: { openKey: string | null; span: number }): React.JSX.Element {
  const [ref, onLeft] = useSecondPanelSide(openKey, span);
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

const AUDIO = 288 + 8;

describe('useSecondPanelSide (#2254)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens on the right when the right has room', () => {
    place(100, 400, 1400);
    render(<Probe openKey='voice' span={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
  });

  it('opens on the left when only the left has room', () => {
    place(1000, 1300, 1400);
    render(<Probe openKey='voice' span={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'true');
  });

  it('stays on the right when neither side has room', () => {
    place(100, 1300, 1400);
    render(<Probe openKey='voice' span={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
  });

  it('measures again when another panel opens', () => {
    place(100, 400, 1400);
    const { rerender } = render(<Probe openKey='voice' span={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
    place(1000, 1300, 1400);
    rerender(<Probe openKey='items:speakers' span={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'true');
  });

  it('does not measure while no second panel is open', () => {
    place(1000, 1300, 1400);
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    spy.mockClear();
    render(<Probe openKey={null} span={AUDIO} />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
  });
});
