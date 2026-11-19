// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { VideoExpandSurface } from '../video/VideoExpandSurface';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('fixed-source video expansion surface', () => {
  it('draws the actual supplied decoded surface with the authoritative source dimensions', () => {
    vi.useFakeTimers();
    const drawImage = vi.fn();
    (vi.spyOn(HTMLCanvasElement.prototype, 'getContext') as unknown as MockInstance<(contextId: string) => unknown>).mockReturnValue({ drawImage });
    const surface = document.createElement('canvas');
    const { container } = render(<VideoExpandSurface source={{ surface, width: 960, height: 540, sourceEpoch: 1, seekEpoch: 2 }} style={{ left: 20, top: 30, width: 400, height: 225 }} />);
    act(() => vi.advanceTimersByTime(20));
    expect(drawImage).toHaveBeenCalledWith(surface, 0, 0, 960, 540);
    expect(container.querySelector('canvas')).toHaveAttribute('width', '960');
    expect(container.querySelector('canvas')).toHaveStyle({ left: '20px', top: '30px' });
  });
  it('releases its scheduled drawing when the expansion frame detaches', () => {
    vi.useFakeTimers();
    (vi.spyOn(HTMLCanvasElement.prototype, 'getContext') as unknown as MockInstance<(contextId: string) => unknown>).mockReturnValue({ drawImage: vi.fn() });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const { unmount } = render(<VideoExpandSurface source={{ surface: document.createElement('canvas'), width: 960, height: 540, sourceEpoch: 1, seekEpoch: 2 }} style={{}} />);
    act(() => vi.advanceTimersByTime(20));
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
