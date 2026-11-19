// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
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

// Execution design §10.3 overlay paragraph and line 1020, demo video-controls.tsx SelectionOverlay: once tracked, the
// selection box itself turns the success colour and follows the object, keeping its move cursor and four resize handles;
// editing it edits the selection. Without a tracked box (outside the range, stale) the user's selection is shown.
describe('the tracked selection box (D6)', () => {
  const selected = { box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, points: [] };
  const tracked = { x: 0.5, y: 0.25, width: 0.25, height: 0.5 };

  it('draws the selection box at the tracked place in the success colour, with its move cursor and four handles', () => {
    render(<VideoToolNodeOverlay {...props} region={selected} trackedBox={tracked} />);
    const box = screen.getByTestId('video-tool-region-box');
    expect(box.className).toContain('border-status-success');
    expect(box.className).toContain('cursor-move');
    expect(box.style).toMatchObject({ left: '50%', top: '25%', width: '25%', height: '50%' });
    expect(box.querySelectorAll('[data-region-handle]')).toHaveLength(4);
  });

  it('moves the box from where it is shown, which edits the selection', () => {
    const onRegion = vi.fn();
    render(<VideoToolNodeOverlay {...props} region={selected} trackedBox={tracked} onRegion={onRegion} />);
    const root = screen.getByTestId('video-tool-node-overlay');
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) });
    const box = screen.getByTestId('video-tool-region-box');
    fireEvent.pointerDown(box, { button: 0, pointerId: 1, clientX: 60, clientY: 50 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 50, clientY: 40 });
    fireEvent.pointerUp(box, { pointerId: 1 });
    expect(onRegion).toHaveBeenCalledExactlyOnceWith({ box: { x: 0.4, y: 0.15000000000000002, width: 0.25, height: 0.5 }, points: [] });
  });

  it('shows the user\'s selection in the selection colour when there is no tracked box', () => {
    render(<VideoToolNodeOverlay {...props} region={selected} trackedBox={null} />);
    const box = screen.getByTestId('video-tool-region-box');
    expect(box.className).toContain('border-status-selected');
    expect(box.style).toMatchObject({ left: '10%', top: '10%' });
  });
});

// Demo video-controls.tsx SelectionOverlay: a reset button at the top right of the video while a selection exists.
describe('the reset button on the video (D4)', () => {
  it('clears the selection', () => {
    const onRegion = vi.fn();
    render(<VideoToolNodeOverlay {...props} region={{ box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, points: [] }} onRegion={onRegion} />);
    fireEvent.click(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.resetSelection') }));
    expect(onRegion).toHaveBeenCalledExactlyOnceWith({ box: null, points: [] });
  });

  it('shows for a point selection too, and not without a selection', () => {
    const { rerender } = render(<VideoToolNodeOverlay {...props} region={{ box: null, points: [{ x: 0.5, y: 0.5, label: 'positive' }] }} onRegion={vi.fn()} />);
    expect(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.resetSelection') })).toBeInTheDocument();
    rerender(<VideoToolNodeOverlay {...props} region={region} onRegion={vi.fn()} />);
    expect(screen.queryByRole('button', { name: t('canvas.miniTool.videoUI.resetSelection') })).toBeNull();
  });
});

// Demo video-controls.tsx SelectionOverlay: the chip at the bottom left of the video.
describe('the selection status chip (D5)', () => {
  it.each([
    [{ tracked: true, selection: 'rectangle' as const }, 'tracked', true],
    [{ tracked: false, selection: 'point' as const }, 'point', false],
    [{ tracked: false, selection: 'rectangle' as const }, 'drawBox', false],
  ])('reads %o as %s', (state, key, check) => {
    render(<VideoToolNodeOverlay {...props} {...state} />);
    const chip = screen.getByTestId('video-tool-selection-status');
    expect(chip.textContent).toBe(t(`canvas.miniTool.videoUI.${key}`));
    expect(chip.querySelector('svg') !== null).toBe(check);
  });
});

// The node player's control bar covers the bottom of the video while shown; the chip rises above it then.
describe('the selection status chip over the control bar (E1)', () => {
  it('sits at the bottom left and lifts above the control bar the overlay host says is shown', () => {
    render(<VideoToolNodeOverlay {...props} />);
    const chip = screen.getByTestId('video-tool-selection-status');
    expect(chip.className).toContain('bottom-2');
    expect(chip.className).toContain('left-2');
    expect(chip.className).toContain('group-data-[controls=shown]/media-overlay:bottom-[calc(var(--btn-inline)+0.875rem)]');
  });
});

// Demo lip-sync-controls.tsx FaceOverlay; canvas design line 98: only the box of the person bound to the active dialogue row
// is drawn in the selected style, every other person's box is neutral.
describe('person boxes follow the active dialogue row (E1)', () => {
  const people = { kind: 'people' as const, analysisRunId: 'run-a', anchor: { frameIndex: 0, pts: 0 }, people: ['person-a', 'person-b'].map((personId, index) => ({ personId, faceBox: { x: index * 0.5, y: 0, width: 0.2, height: 0.2 }, artifactRefs: [] })) } as unknown as NonNullable<React.ComponentProps<typeof VideoToolNodeOverlay>['people']>;

  it('draws only the active row\'s person in the selected style', () => {
    render(<VideoToolNodeOverlay {...props} region={undefined} people={people} activePersonId='person-b' />);
    const [first, second] = screen.getAllByRole('button', { pressed: undefined }).filter((button) => button.hasAttribute('aria-pressed'));
    expect(second).toHaveAttribute('aria-pressed', 'true');
    expect(second!.className).toContain('border-status-selected');
    expect(first!.className).not.toContain('status-selected');
    expect(first!.className).toContain('border-border');
  });

  // Canvas design line 98: a person over the people limit is aria-disabled and dimmed, and a press still reaches the panel,
  // which explains the limit with a toast.
  it('dims a capped person\'s box and still reports its press', () => {
    const onPerson = vi.fn();
    render(<VideoToolNodeOverlay {...props} region={undefined} people={people} activePersonId='person-a' cappedPersonIds={new Set(['person-b'])} onPerson={onPerson} />);
    const [first, second] = screen.getAllByRole('button').filter((button) => button.hasAttribute('aria-pressed'));
    expect(second).toHaveAttribute('aria-disabled', 'true');
    expect(second).not.toBeDisabled();
    expect(second!.className).toContain('aria-disabled:opacity-50');
    expect(first).not.toHaveAttribute('aria-disabled');
    fireEvent.click(second!);
    expect(onPerson).toHaveBeenCalledWith('person-b');
  });
});
