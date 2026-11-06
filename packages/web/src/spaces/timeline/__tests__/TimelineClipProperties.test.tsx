// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The selected clip's start, in-point and duration fields (inner#1708 P4). */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { t, type TimelineDocumentV1, type TimelineVideoClip } from '@breatic/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import { MAIN, OFF, ON, SHORT_SOURCE, SOURCE, V2, cid, clip, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';
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

/** How the panel is shown besides its clip. */
interface PanelOptions { readOnly?: boolean; placement?: TimelineEditPlacement }

/**
 * Render the fields and keep a way to rerender them with another stored clip, as a store update does.
 * @param selected - The first clip.
 * @returns The commit callback and the rerender.
 * @throws {Error} When rendering fails.
 */
function showLive(selected: TimelineVideoClip = SELECTED): { onCommit: ReturnType<typeof vi.fn<(command: TimelineEditCommand) => void>>; show: (next: TimelineVideoClip, options?: PanelOptions) => void } {
  const onCommit = vi.fn<(command: TimelineEditCommand) => void>();
  /**
   * The panel for one stored clip.
   * @param item - The clip.
   * @param options - The role and switches, read-write with every switch off by default.
   * @returns The element, keyed by the clip id as TimelineSpace renders it.
   * @throws {never} Never.
   */
  const panel = (item: TimelineVideoClip, options: PanelOptions = {}): React.JSX.Element => <TimelineClipProperties key={item.id} spaceId='space' document={timeline([item], undefined, [SOURCE, SHORT_SOURCE])} clip={item} name='Clip' conflict={false}
    labels={LABELS} readOnly={options.readOnly ?? false} placement={options.placement ?? OFF} onCommit={onCommit} />;
  const view = render(panel(selected));
  return { onCommit, show: (next, options) => view.rerender(panel(next, options)) };
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

/**
 * Type into a field and press Enter.
 * @param testId - The field.
 * @param value - The typed text.
 * @throws {Error} When the field is absent.
 */
function typeAndEnter(testId: string, value: string): void {
  const input = screen.getByTestId(testId);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

/**
 * The text a field shows, whether it is an input or plain text.
 * @param testId - The field.
 * @returns Its value or text.
 * @throws {Error} When the field is absent.
 */
function fieldText(testId: string): string {
  const element = screen.getByTestId(testId);
  return element instanceof HTMLInputElement ? element.value : element.textContent ?? '';
}

describe('TimelineClipProperties shows the stored value of a field that cannot be edited (inner#1708 R1)', () => {
  it('drops an out-of-range start draft while magnet locks the start, and starts again from the stored start (a)', () => {
    const onMain = clip(cid(5), MAIN, 30, 14, { sourceInFrame: 4 });
    const { show } = showLive(onMain);
    typeAndBlur('timeline-clip-start', '99999999999999999999');
    expect(noteBeside('timeline-clip-start')).toBe(true);
    show(onMain, { placement: ON });
    expect(screen.getByTestId('timeline-clip-start')).not.toBeInstanceOf(HTMLInputElement);
    expect(fieldText('timeline-clip-start')).toBe('30');
    expect(noteBeside('timeline-clip-start')).toBe(false);
    show(onMain, { placement: OFF });
    expect(screen.getByTestId('timeline-clip-start')).toBeInstanceOf(HTMLInputElement);
    expect(fieldText('timeline-clip-start')).toBe('30');
    expect(noteBeside('timeline-clip-start')).toBe(false);
  });

  it('drops an out-of-range duration draft while read-only, and starts again from the stored duration (b)', () => {
    const { show } = showLive();
    typeAndBlur('timeline-clip-duration', '0');
    expect(noteBeside('timeline-clip-duration')).toBe(true);
    show(SELECTED, { readOnly: true });
    expect(fieldText('timeline-clip-duration')).toBe('14');
    expect(noteBeside('timeline-clip-duration')).toBe(false);
    show(SELECTED, { readOnly: false });
    expect(screen.getByTestId('timeline-clip-duration')).toBeInstanceOf(HTMLInputElement);
    expect(fieldText('timeline-clip-duration')).toBe('14');
    expect(noteBeside('timeline-clip-duration')).toBe(false);
  });
});

describe('TimelineClipProperties shows the stored value after a committed entry (inner#1708 Q1)', () => {
  it.each([
    ['timeline-clip-start', '30', { operation: 'move', parameters: { clipId: SELECTED.id, startFrame: 30 }, placement: OFF }, '10'],
    ['timeline-clip-in', '2', { operation: 'set_range', parameters: { clipId: SELECTED.id, startFrame: 10, sourceInFrame: 2, durationFrames: 14 }, placement: OFF }, '4'],
    ['timeline-clip-duration', '20', { operation: 'set_range', parameters: { clipId: SELECTED.id, startFrame: 10, sourceInFrame: 4, durationFrames: 20 }, placement: OFF }, '14'],
  ] as const)('returns %s to its stored value when the planner refuses the commit (a)', (testId, typed, command, stored) => {
    const { onCommit } = showLive();
    typeAndEnter(testId, typed);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(command);
    expect(fieldText(testId)).toBe(stored);
    expect(noteBeside(testId)).toBe(false);
  });

  it('commits nothing for the stored in-point in another spelling and shows the stored value (b)', () => {
    const { onCommit } = showLive();
    typeAndEnter('timeline-clip-in', '04');
    expect(onCommit).not.toHaveBeenCalled();
    expect(fieldText('timeline-clip-in')).toBe('4');
  });

  it('commits once for Enter followed by blur on the same entry (c)', () => {
    const { onCommit } = showLive();
    typeAndEnter('timeline-clip-start', '30');
    fireEvent.blur(screen.getByTestId('timeline-clip-start'));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('returns a refused in-point to its stored value while the duration keeps its draft and note (d)', () => {
    const { onCommit } = showLive();
    typeAndBlur('timeline-clip-duration', '2000');
    expect(noteBeside('timeline-clip-duration')).toBe(true);
    typeAndEnter('timeline-clip-in', '2');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(fieldText('timeline-clip-in')).toBe('4');
    expect(noteBeside('timeline-clip-in')).toBe(false);
    expect(fieldText('timeline-clip-duration')).toBe('2000');
    expect(noteBeside('timeline-clip-duration')).toBe(true);
  });
});

describe('TimelineClipProperties clears a field note once an in-range entry is committed (inner#1708 E1)', () => {
  const A = clip(cid(7), V2, 10, 20, { sourceInFrame: 20, sourceId: SHORT_SOURCE.id });

  /**
   * Leave duration 40 out of range beside in 20, then commit in 0 and store it, so 40 now fits.
   * @returns The commit callback and the rerender.
   * @throws {Error} When a step does not behave as set up.
   */
  function durationFitsAfterInPoint(): ReturnType<typeof showLive> {
    const live = showLive(A);
    typeAndBlur('timeline-clip-duration', '40');
    expect(noteBeside('timeline-clip-duration')).toBe(true);
    typeAndBlur('timeline-clip-in', '0');
    expect(live.onCommit).toHaveBeenLastCalledWith({
      operation: 'set_range', parameters: { clipId: A.id, startFrame: 10, sourceInFrame: 0, durationFrames: 20 }, placement: OFF,
    });
    live.show({ ...A, sourceInFrame: 0 });
    expect(noteBeside('timeline-clip-duration')).toBe(true);
    return live;
  }

  it('shows the stored duration without a note after the planner refuses the now-fitting entry', () => {
    const { onCommit } = durationFitsAfterInPoint();
    fireEvent.keyDown(screen.getByTestId('timeline-clip-duration'), { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith({
      operation: 'set_range', parameters: { clipId: A.id, startFrame: 10, sourceInFrame: 0, durationFrames: 40 }, placement: OFF,
    });
    expect(fieldText('timeline-clip-duration')).toBe('20');
    expect(noteBeside('timeline-clip-duration')).toBe(false);
  });

  it('shows the stored duration without a note when the entry equals it', () => {
    const { onCommit } = durationFitsAfterInPoint();
    typeAndEnter('timeline-clip-duration', '20');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(fieldText('timeline-clip-duration')).toBe('20');
    expect(noteBeside('timeline-clip-duration')).toBe(false);
  });
});

describe('TimelineClipProperties marks an out-of-range field invalid (inner#1708 visual V8)', () => {
  it('sets aria-invalid with the note and clears it after an in-range commit', () => {
    showLive();
    typeAndBlur('timeline-clip-duration', '99999999');
    expect(screen.getByTestId('timeline-clip-duration')).toHaveAttribute('aria-invalid', 'true');
    expect(noteBeside('timeline-clip-duration')).toBe(true);
    typeAndBlur('timeline-clip-duration', '20');
    expect(screen.getByTestId('timeline-clip-duration')).not.toHaveAttribute('aria-invalid', 'true');
    expect(noteBeside('timeline-clip-duration')).toBe(false);
  });
});

describe('TimelineClipProperties names the source length and rate (inner#1708 visual V18)', () => {
  it('shows the source frames at a whole frame rate', () => {
    showLive();
    expect(screen.getByTestId('timeline-clip-source')).toHaveTextContent(t('timeline.sourceExtent', { frames: SOURCE.extentFrames, fps: 24 }));
  });

  it('shows a fractional frame rate rounded to two decimals', () => {
    const ntsc = { num: 30000, den: 1001 };
    const base = timeline([SELECTED]);
    const document: TimelineDocumentV1 = {
      ...base, settings: { ...base.settings, fps: ntsc },
      sources: { [SOURCE.id]: { ...SOURCE, timebase: ntsc } },
    };
    render(<TimelineClipProperties spaceId='space' document={document} clip={SELECTED} name='Clip' conflict={false}
      labels={LABELS} readOnly={false} placement={OFF} onCommit={vi.fn()} />);
    expect(screen.getByTestId('timeline-clip-source')).toHaveTextContent(t('timeline.sourceExtent', { frames: SOURCE.extentFrames, fps: 29.97 }));
  });

  it('shows no source line when the source is missing', () => {
    showLive(clip(cid(8), V2, 10, 14, { sourceId: '10000000-0000-4000-8000-0000000000fe' }));
    expect(screen.queryByTestId('timeline-clip-source')).toBe(null);
    expect(screen.getByTestId('timeline-clip-duration')).toBeInTheDocument();
  });
});
