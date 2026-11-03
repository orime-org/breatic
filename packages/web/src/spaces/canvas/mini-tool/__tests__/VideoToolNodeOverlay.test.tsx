// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VideoToolNodeOverlay } from '../video/VideoToolNodeOverlay';

const region = { box: null, points: [] };
const props = { region, revision: 'revision-a', sourceEpoch: 1, seekEpoch: 1, disabled: false };

describe('source selection gesture ownership', () => {
  it('commits source-normalized geometry once when the owning pointer completes', () => {
    const onRegion = vi.fn();
    render(<VideoToolNodeOverlay {...props} onRegion={onRegion} />);
    const root = screen.getByTestId('video-tool-node-overlay');
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) });
    const layer = screen.getByTestId('video-tool-region-gesture');
    fireEvent.pointerDown(layer, { button: 0, pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: 60, clientY: 80 });
    expect(onRegion).toHaveBeenCalledTimes(0);
    fireEvent.pointerUp(layer, { pointerId: 1 });
    expect(onRegion).toHaveBeenCalledTimes(1);
    expect(onRegion).toHaveBeenCalledWith({ box: { x: 0.1, y: 0.2, width: 0.5, height: 0.6000000000000001 }, points: [] });
  });
  it('keeps a remote revision after a stale pointer finishes', () => {
    const onRegion = vi.fn();
    const { rerender } = render(<VideoToolNodeOverlay {...props} onRegion={onRegion} />);
    const root = screen.getByTestId('video-tool-node-overlay');
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) });
    const layer = screen.getByTestId('video-tool-region-gesture');
    fireEvent.pointerDown(layer, { button: 0, pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: 60, clientY: 80 });
    rerender(<VideoToolNodeOverlay {...props} revision='revision-b' onRegion={onRegion} />);
    fireEvent.pointerUp(screen.getByTestId('video-tool-region-gesture'), { pointerId: 1 });
    expect(onRegion).toHaveBeenCalledTimes(0);
  });
});
