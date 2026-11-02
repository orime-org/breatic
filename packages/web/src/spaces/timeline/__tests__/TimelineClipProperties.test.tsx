// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The selected clip's start, in-point and duration fields (inner#1708 P4). */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TimelineVideoClip } from '@breatic/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TimelineEditCommand } from '@web/data/yjs/timeline-edit';
import { OFF, V2, cid, clip, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { TimelineClipProperties } from '@web/spaces/timeline/TimelineClipProperties';
import type { TimelineTrackLabels } from '@web/spaces/timeline/timeline-track-labels';

const SELECTED = clip(cid(1), V2, 10, 14, { sourceInFrame: 4 });
const LABELS: TimelineTrackLabels = { visual: [{ id: V2, label: 'Visual 2' }], nameOf: () => 'Visual 2' };

afterEach(() => {
  cleanup();
});

/**
 * Render the fields for a selected sub-track clip.
 * @param selected - The clip, SELECTED by default.
 * @returns The commit callback.
 * @throws {Error} When rendering fails.
 */
function showFields(selected: TimelineVideoClip = SELECTED): ReturnType<typeof vi.fn<(command: TimelineEditCommand) => void>> {
  const onCommit = vi.fn<(command: TimelineEditCommand) => void>();
  render(<TimelineClipProperties spaceId='space' document={timeline([selected])} clip={selected} name='Clip' conflict={false}
    labels={LABELS} readOnly={false} placement={OFF} onCommit={onCommit} />);
  return onCommit;
}

/**
 * Type into a field and leave it.
 * @param testId - The field.
 * @param value - The typed text.
 * @throws {Error} When the field is absent.
 */
function typeAndBlur(testId: string, value: string): void {
  const input = screen.getByTestId(testId);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('TimelineClipProperties field input', () => {
  it.each(['timeline-clip-start', 'timeline-clip-in', 'timeline-clip-duration'])('commits nothing and shows the error when %s is cleared', (testId) => {
    const onCommit = showFields();
    typeAndBlur(testId, '');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId('timeline-clip-field-error')).toBeInTheDocument();
  });

  it.each(['timeline-clip-start', 'timeline-clip-in', 'timeline-clip-duration'])('commits nothing and shows the error for non-digit text in %s', (testId) => {
    const onCommit = showFields();
    typeAndBlur(testId, '1e1');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId('timeline-clip-field-error')).toBeInTheDocument();
  });

  it('commits a typed start frame as a move', () => {
    const onCommit = showFields();
    typeAndBlur('timeline-clip-start', '30');
    expect(onCommit).toHaveBeenCalledWith({ operation: 'move', parameters: { clipId: SELECTED.id, startFrame: 30 }, placement: OFF });
    expect(screen.queryByTestId('timeline-clip-field-error')).toBe(null);
  });

  it('commits a typed in-point as a set_range', () => {
    const onCommit = showFields();
    typeAndBlur('timeline-clip-in', '2');
    expect(onCommit).toHaveBeenCalledWith({
      operation: 'set_range', parameters: { clipId: SELECTED.id, startFrame: 10, sourceInFrame: 2, durationFrames: 14 }, placement: OFF,
    });
  });
});

describe('TimelineClipProperties for a clip whose source is missing (inner#1708 R1)', () => {
  const SOURCELESS = clip(cid(2), V2, 10, 14, { sourceInFrame: 4, sourceId: '10000000-0000-4000-8000-0000000000ff' });

  it('commits a valid in-point for the planner to judge', () => {
    const onCommit = showFields(SOURCELESS);
    typeAndBlur('timeline-clip-in', '2');
    expect(onCommit).toHaveBeenCalledWith({
      operation: 'set_range', parameters: { clipId: SOURCELESS.id, startFrame: 10, sourceInFrame: 2, durationFrames: 14 }, placement: OFF,
    });
    expect(screen.queryByTestId('timeline-clip-field-error')).toBe(null);
  });

  it('commits a valid duration for the planner to judge', () => {
    const onCommit = showFields(SOURCELESS);
    typeAndBlur('timeline-clip-duration', '20');
    expect(onCommit).toHaveBeenCalledWith({
      operation: 'set_range', parameters: { clipId: SOURCELESS.id, startFrame: 10, sourceInFrame: 4, durationFrames: 20 }, placement: OFF,
    });
    expect(screen.queryByTestId('timeline-clip-field-error')).toBe(null);
  });

  it('still shows the field error and commits nothing for an out-of-source range of a clip with its source', () => {
    const onCommit = showFields();
    typeAndBlur('timeline-clip-duration', '2000');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId('timeline-clip-field-error')).toBeInTheDocument();
  });
});
