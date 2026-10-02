// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { useSecondPanelSide } from '@web/spaces/canvas/generate/use-second-panel-side';

/**
 * Renders a first panel and reports which side the second one opens on.
 * @param props - The hook's arguments.
 * @param props.openKey - Which second panel is open.
 * @param props.spanOf - How far the second panel reaches.
 * @returns The probe.
 */
function Probe({ openKey, spanOf }: { openKey: string | null; spanOf: () => number }): React.JSX.Element {
  const [ref, onLeft] = useSecondPanelSide(openKey, spanOf);
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

const AUDIO = (): number => 288 + 8;

describe('useSecondPanelSide (#2254)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens on the right when the right has room', () => {
    place(100, 400, 1400);
    render(<Probe openKey='voice' spanOf={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
  });

  it('opens on the left when only the left has room', () => {
    place(1000, 1300, 1400);
    render(<Probe openKey='voice' spanOf={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'true');
  });

  it('stays on the right when neither side has room', () => {
    place(100, 1300, 1400);
    render(<Probe openKey='voice' spanOf={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
  });

  it('measures again when another panel opens', () => {
    place(100, 400, 1400);
    const { rerender } = render(<Probe openKey='voice' spanOf={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
    place(1000, 1300, 1400);
    rerender(<Probe openKey='items:speakers' spanOf={AUDIO} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'true');
  });

  it('reads the span at the moment it measures, so a capped width is the one that counts', () => {
    // 500px window: the camera panel is capped at 88vw = 440px and needs 448px
    // beside the first panel. The left has 460, so it opens there; a fixed
    // 520 + 8 would find no room on either side and stay right.
    place(460, 460, 500);
    render(<Probe openKey='camera' spanOf={() => Math.min(520, window.innerWidth * 0.88) + 8} />);
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'true');
  });

  it('does not measure while no second panel is open', () => {
    place(1000, 1300, 1400);
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    spy.mockClear();
    render(<Probe openKey={null} spanOf={AUDIO} />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId('first')).toHaveAttribute('data-left', 'false');
  });
});
