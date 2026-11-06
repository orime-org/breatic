// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The selected clip's start, in-point and duration fields (inner#1708 P4). */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

/**
 * Render the fields and keep a way to rerender them with another stored clip, as a store update does.
 * @param selected - The first clip.
 * @returns The commit callback and the rerender.
 * @throws {Error} When rendering fails.
 */
function showLive(selected: TimelineVideoClip = SELECTED): { onCommit: ReturnType<typeof vi.fn<(command: TimelineEditCommand) => void>>; show: (next: TimelineVideoClip) => void } {
  const onCommit = vi.fn<(command: TimelineEditCommand) => void>();
  /**
   * The panel for one stored clip.
   * @param item - The clip.
   * @returns The element.
   * @throws {never} Never.
   */
  const panel = (item: TimelineVideoClip): React.JSX.Element => <TimelineClipProperties spaceId='space' document={timeline([item])} clip={item} name='Clip' conflict={false}
    labels={LABELS} readOnly={false} placement={OFF} onCommit={onCommit} />;
  const view = render(panel(selected));
  return { onCommit, show: (next) => view.rerender(panel(next)) };
}

/**
 * Whether a field shows the out-of-range note beside it.
 * @param testId - The field.
 * @returns Whether its own container holds the note.
 * @throws {Error} When the field is absent.
 */
function noteBeside(testId: string): boolean {
  const container = screen.getByTestId(testId).parentElement;
  if (container === null) throw new Error(`${testId} has no container`);
  return within(container).queryByTestId('timeline-clip-field-error') !== null;
}

/**
 * The text a field shows.
 * @param testId - The field.
 * @returns Its input value.
 * @throws {Error} When the field is absent.
 */
function shown(testId: string): string {
  return (screen.getByTestId(testId) as HTMLInputElement).value;
}

describe('TimelineClipProperties judges each field with the stored values of the others (inner#1708 G1)', () => {
  it('commits an in-point with the stored duration while the duration holds an out-of-range draft (a)', () => {
    const { onCommit } = showLive();
    typeAndBlur('timeline-clip-duration', '2000');
    expect(onCommit).not.toHaveBeenCalled();
    expect(noteBeside('timeline-clip-duration')).toBe(true);
    typeAndBlur('timeline-clip-in', '2');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({
      operation: 'set_range', parameters: { clipId: SELECTED.id, startFrame: 10, sourceInFrame: 2, durationFrames: 14 }, placement: OFF,
    });
    expect(shown('timeline-clip-duration')).toBe('2000');
    expect(noteBeside('timeline-clip-duration')).toBe(true);
    expect(noteBeside('timeline-clip-in')).toBe(false);
  });

  it('commits a duration with the stored in-point while the in-point holds an out-of-range draft (b)', () => {
    const { onCommit } = showLive();
    typeAndBlur('timeline-clip-in', '995');
    expect(onCommit).not.toHaveBeenCalled();
    expect(noteBeside('timeline-clip-in')).toBe(true);
    typeAndBlur('timeline-clip-duration', '10');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({
      operation: 'set_range', parameters: { clipId: SELECTED.id, startFrame: 10, sourceInFrame: 4, durationFrames: 10 }, placement: OFF,
    });
    expect(shown('timeline-clip-in')).toBe('995');
    expect(noteBeside('timeline-clip-in')).toBe(true);
    expect(noteBeside('timeline-clip-duration')).toBe(false);
  });

  it('judges an in-point with the stored duration, not a pending duration draft (c)', () => {
    const { onCommit } = showLive();
    fireEvent.change(screen.getByTestId('timeline-clip-duration'), { target: { value: '5' } });
    typeAndBlur('timeline-clip-in', '990');
    expect(onCommit).not.toHaveBeenCalled();
    expect(noteBeside('timeline-clip-in')).toBe(true);
    expect(noteBeside('timeline-clip-duration')).toBe(false);
  });

  it('commits a start frame as a move and leaves the duration draft and its note (d)', () => {
    const { onCommit } = showLive();
    typeAndBlur('timeline-clip-duration', '2000');
    typeAndBlur('timeline-clip-start', '30');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ operation: 'move', parameters: { clipId: SELECTED.id, startFrame: 30 }, placement: OFF });
    expect(shown('timeline-clip-duration')).toBe('2000');
    expect(noteBeside('timeline-clip-duration')).toBe(true);
    expect(noteBeside('timeline-clip-start')).toBe(false);
  });
});

describe('TimelineClipProperties resets a field only when its own stored value changes (inner#1708 G2)', () => {
  it('keeps the duration draft and note when a peer shifts the start frame', () => {
    const { show } = showLive();
    typeAndBlur('timeline-clip-duration', '2000');
    show({ ...SELECTED, startFrame: 5 });
    expect(shown('timeline-clip-duration')).toBe('2000');
    expect(noteBeside('timeline-clip-duration')).toBe(true);
  });

  it('shows the new stored duration without a note when the duration itself changes', () => {
    const { show } = showLive();
    typeAndBlur('timeline-clip-duration', '2000');
    show({ ...SELECTED, durationFrames: 20 });
    expect(shown('timeline-clip-duration')).toBe('20');
    expect(noteBeside('timeline-clip-duration')).toBe(false);
  });

  it('keeps a pending in-point draft and note when a valid duration is committed and stored', () => {
    const { onCommit, show } = showLive();
    typeAndBlur('timeline-clip-in', '995');
    typeAndBlur('timeline-clip-duration', '20');
    expect(onCommit).toHaveBeenCalledWith({
      operation: 'set_range', parameters: { clipId: SELECTED.id, startFrame: 10, sourceInFrame: 4, durationFrames: 20 }, placement: OFF,
    });
    show({ ...SELECTED, durationFrames: 20 });
    expect(shown('timeline-clip-duration')).toBe('20');
    expect(shown('timeline-clip-in')).toBe('995');
    expect(noteBeside('timeline-clip-in')).toBe(true);
  });

  it('resets every field when another clip is selected', () => {
    const { show } = showLive();
    typeAndBlur('timeline-clip-duration', '2000');
    fireEvent.change(screen.getByTestId('timeline-clip-in'), { target: { value: '7' } });
    const other = clip(cid(3), V2, 40, 30, { sourceInFrame: 6 });
    show(other);
    expect(shown('timeline-clip-start')).toBe('40');
    expect(shown('timeline-clip-in')).toBe('6');
    expect(shown('timeline-clip-duration')).toBe('30');
    expect(screen.queryByTestId('timeline-clip-field-error')).toBe(null);
  });
});
