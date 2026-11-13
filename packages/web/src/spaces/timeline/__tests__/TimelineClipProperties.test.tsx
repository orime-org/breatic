// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The selected clip's start, in-point and duration fields (inner#1708 P4). */

import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { TIMELINE_LAYER_TRANSFORM_LIMITS, setLocale, t, type TimelineClip, type TimelineDocumentV1, type TimelineVideoClip } from '@breatic/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import { MAIN, OFF, ON, SHORT_SOURCE, SOURCE, V2, cid, clip, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { RESOLUTION, webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';
import { uploadClip } from '@web/data/yjs/__tests__/timeline-upload-fixtures';
import { TimelineClipProperties } from '@web/spaces/timeline/TimelineClipProperties';
import { renderWithTooltips } from '@web/test-utils/render-with-tooltips';
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
  renderWithTooltips(<TimelineClipProperties spaceId='space' document={timeline([selected])} clip={selected} name='Clip' conflict={false}
    labels={LABELS} readOnly={false} placement={OFF} atFrame onCommit={onCommit} />);
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

  it.each(['timeline-clip-start', 'timeline-clip-in', 'timeline-clip-duration'])('keeps the frame-range copy for an invalid %s (breatic#1410)', (testId) => {
    showFields();
    typeAndBlur(testId, '');
    expect(t('timeline.errors.invalid_range')).toBe('Enter a frame range inside the video.');
    expect(screen.getByTestId('timeline-clip-field-error')).toHaveTextContent('Enter a frame range inside the video.');
  });

  it.each(['timeline-clip-start', 'timeline-clip-in', 'timeline-clip-duration'])('commits nothing and shows the error for non-digit text in %s', (testId) => {
    const onCommit = showFields();
    typeAndBlur(testId, '1e1');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId('timeline-clip-field-error')).toBeInTheDocument();
  });

  it('names the in-point and duration fields in frames', () => {
    showFields();
    expect(t('timeline.edit.inPoint')).toBe('In point (frames)');
    expect(t('timeline.edit.duration')).toBe('Duration (frames)');
    expect(screen.getByText('In point (frames)').tagName).toBe('LABEL');
    expect(screen.getByText('Duration (frames)').tagName).toBe('LABEL');
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
    labels={LABELS} readOnly={options.readOnly ?? false} placement={options.placement ?? OFF} atFrame onCommit={onCommit} />;
  const view = renderWithTooltips(panel(selected));
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
    renderWithTooltips(<TimelineClipProperties spaceId='space' document={document} clip={SELECTED} name='Clip' conflict={false}
      labels={LABELS} readOnly={false} placement={OFF} atFrame onCommit={vi.fn()} />);
    expect(screen.getByTestId('timeline-clip-source')).toHaveTextContent(t('timeline.sourceExtent', { frames: SOURCE.extentFrames, fps: 29.97 }));
  });

  it('shows no source line when the source is missing', () => {
    showLive(clip(cid(8), V2, 10, 14, { sourceId: '10000000-0000-4000-8000-0000000000fe' }));
    expect(screen.queryByTestId('timeline-clip-source')).toBe(null);
    expect(screen.getByTestId('timeline-clip-duration')).toBeInTheDocument();
  });
});

/**
 * The position and size group (breatic#1410 design §5, §3.1). Fields `timeline-clip-x`, `-y` (canvas pixels, whole
 * numbers shown), `-scale-x`, `-scale-y` (percent, one decimal, 1% to 10000%), `-rotation` (degrees, one decimal) and the
 * ratio lock `timeline-clip-lock-ratio` (a labelled Switch with `aria-checked`, on by default, last in the group). Fields commit like the frame
 * fields and SceneField: Enter or blur, only when the text differs from what is shown; an invalid entry is marked
 * (`aria-invalid` and the note beside it) and writes nothing; Escape restores the shown value. A commit is
 * `{ operation: 'set_transform', parameters: { clipId, transform }, placement }` with the other parts as stored and
 * the edited part rounded (x, y to 0.01, scale to 0.0001, rotation to 0.01 and normalised to -180..180).
 */
describe('TimelineClipProperties position and size (breatic#1410)', () => {
  type Transform = TimelineVideoClip['transform'];
  // Shown as 100, -51, 33.3, 25.7 and 12.3, with no rounding ambiguity in what is shown.
  const STORED: Transform = { x: 100.4, y: -50.6, scaleX: 0.3333, scaleY: 0.2567, rotation: 12.34 };
  const PLACED = clip(cid(21), V2, 10, 14, { transform: STORED });
  const FIELDS = ['timeline-clip-x', 'timeline-clip-y', 'timeline-clip-scale-x', 'timeline-clip-scale-y', 'timeline-clip-rotation'] as const;

  /**
   * Render the panel for one clip.
   * @param selected - The clip.
   * @param readOnly - Whether the user is a Viewer.
   * @param atFrame - Whether the clip covers the playhead.
   * @returns The commit callback.
   * @throws {Error} When rendering fails.
   */
  function showPlaced(selected: TimelineClip = PLACED, readOnly = false, atFrame = true): ReturnType<typeof vi.fn<(command: TimelineEditCommand) => void>> {
    const onCommit = vi.fn<(command: TimelineEditCommand) => void>();
    renderWithTooltips(<TimelineClipProperties spaceId='space' document={timeline([selected])} web={RESOLUTION} clip={selected} name='Clip' conflict={false}
      labels={LABELS} readOnly={readOnly} placement={OFF} atFrame={atFrame} onCommit={onCommit} />);
    return onCommit;
  }

  /**
   * The command a commit of this transform sends.
   * @param transform - The whole transform.
   * @param clipId - The clip.
   * @returns The command.
   * @throws {never} Never.
   */
  const setTransform = (transform: Transform, clipId = PLACED.id): unknown => ({ operation: 'set_transform', parameters: { clipId, transform }, placement: OFF });

  it('shows position in whole canvas pixels, scale in percent and rotation in degrees with one decimal', () => {
    showPlaced();
    expect(fieldText('timeline-clip-x')).toBe('100');
    expect(fieldText('timeline-clip-y')).toBe('-51');
    expect(fieldText('timeline-clip-scale-x')).toBe('33.3');
    expect(fieldText('timeline-clip-scale-y')).toBe('25.7');
    expect(fieldText('timeline-clip-rotation')).toBe('12.3');
    expect(screen.getByTestId('timeline-clip-lock-ratio')).toHaveAttribute('aria-checked', 'true');
  });

  it('commits a changed X on Enter as one set_transform carrying the other parts as stored', () => {
    const onCommit = showPlaced();
    typeAndEnter('timeline-clip-x', '300');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(setTransform({ ...STORED, x: 300 }));
  });

  it('commits a changed Y on blur, rounded to 0.01 canvas pixels', () => {
    const onCommit = showPlaced();
    typeAndBlur('timeline-clip-y', '-20.456');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(setTransform({ ...STORED, y: -20.46 }));
  });

  it.each(FIELDS)('sends nothing when %s is focused and left without a change', (testId) => {
    const onCommit = showPlaced();
    const input = screen.getByTestId(testId);
    input.focus();
    fireEvent.focus(input);
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
  });

  it.each([
    ['timeline-clip-x', 'abc'],
    ['timeline-clip-y', ''],
    ['timeline-clip-scale-x', '0.9'],
    ['timeline-clip-scale-y', '10001'],
    ['timeline-clip-rotation', '1e'],
  ] as const)('marks %s invalid for "%s", writes nothing, and Escape restores the shown value', (testId, typed) => {
    const onCommit = showPlaced();
    const shownBefore = fieldText(testId);
    typeAndEnter(testId, typed);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId(testId)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByTestId('timeline-clip-field-error')).toHaveLength(1);
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Escape' });
    expect(fieldText(testId)).toBe(shownBefore);
    expect(screen.getByTestId(testId)).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByTestId('timeline-clip-field-error')).toBe(null);
    fireEvent.blur(screen.getByTestId(testId));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('drops an uncommitted valid entry on Escape and sends nothing when the field is left', () => {
    const onCommit = showPlaced();
    const input = screen.getByTestId('timeline-clip-x');
    fireEvent.change(input, { target: { value: '300' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(fieldText('timeline-clip-x')).toBe('100');
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('accepts the scale bounds 1% and 10000% as 0.01 and 100', () => {
    const onCommit = showPlaced();
    fireEvent.click(screen.getByTestId('timeline-clip-lock-ratio'));
    typeAndEnter('timeline-clip-scale-x', '1');
    expect(onCommit).toHaveBeenLastCalledWith(setTransform({ ...STORED, scaleX: 0.01 }));
    typeAndEnter('timeline-clip-scale-y', '10000');
    expect(onCommit).toHaveBeenLastCalledWith(setTransform({ ...STORED, scaleY: 100 }));
  });

  it('rounds a typed scale to 0.0001 with the ratio unlocked, leaving the other axis as stored', () => {
    const onCommit = showPlaced();
    const lock = screen.getByTestId('timeline-clip-lock-ratio');
    fireEvent.click(lock);
    expect(lock).toHaveAttribute('aria-checked', 'false');
    typeAndEnter('timeline-clip-scale-x', '12.3456');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(setTransform({ ...STORED, scaleX: 0.1235 }));
  });

  it('normalises a typed rotation to -180..180 and rounds it to 0.01 degree', () => {
    const onCommit = showPlaced();
    typeAndEnter('timeline-clip-rotation', '190');
    expect(onCommit).toHaveBeenLastCalledWith(setTransform({ ...STORED, rotation: -170 }));
    typeAndEnter('timeline-clip-rotation', '370.123');
    expect(onCommit).toHaveBeenLastCalledWith(setTransform({ ...STORED, rotation: 10.12 }));
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  describe('with the ratio locked', () => {
    const HALF = clip(cid(22), V2, 10, 14, { transform: { x: 10, y: 20, scaleX: 0.5, scaleY: 0.25, rotation: 5 } });

    it('moves the other scale by the same ratio when one scale is edited', () => {
      const onCommit = showPlaced(HALF);
      typeAndEnter('timeline-clip-scale-x', '100');
      expect(onCommit).toHaveBeenLastCalledWith(setTransform({ x: 10, y: 20, scaleX: 1, scaleY: 0.5, rotation: 5 }, HALF.id));
      typeAndEnter('timeline-clip-scale-y', '50');
      expect(onCommit).toHaveBeenLastCalledWith(setTransform({ x: 10, y: 20, scaleX: 1, scaleY: 0.5, rotation: 5 }, HALF.id));
    });

    it('changes only the edited part for position and rotation', () => {
      const onCommit = showPlaced(HALF);
      typeAndEnter('timeline-clip-x', '40');
      expect(onCommit).toHaveBeenLastCalledWith(setTransform({ x: 40, y: 20, scaleX: 0.5, scaleY: 0.25, rotation: 5 }, HALF.id));
      typeAndEnter('timeline-clip-rotation', '-30');
      expect(onCommit).toHaveBeenLastCalledWith(setTransform({ x: 10, y: 20, scaleX: 0.5, scaleY: 0.25, rotation: -30 }, HALF.id));
    });
  });

  it('shows a Viewer the values as text with no input and no ratio lock', () => {
    const onCommit = showPlaced(PLACED, true);
    for (const testId of FIELDS) expect(screen.getByTestId(testId)).not.toBeInstanceOf(HTMLInputElement);
    expect(fieldText('timeline-clip-x')).toBe('100');
    expect(fieldText('timeline-clip-scale-x')).toBe('33.3');
    expect(fieldText('timeline-clip-rotation')).toBe('12.3');
    expect(screen.queryAllByTestId('timeline-clip-lock-ratio')).toHaveLength(0);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryByText('Lock ratio')).toBe(null);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('offers the group for a web-animation copy and not for an upload placeholder', () => {
    const copy = webClip(cid(23), V2, 0, 48, undefined, { transform: STORED });
    showPlaced(copy);
    expect(fieldText('timeline-clip-x')).toBe('100');
    cleanup();
    showPlaced(uploadClip(cid(24), V2, 0));
    expect(screen.queryByTestId('timeline-clip-x')).toBe(null);
    expect(screen.queryByTestId('timeline-clip-lock-ratio')).toBe(null);
  });

  it('labels the scale and rotation fields from the locale catalogs', () => {
    showPlaced();
    const labelOf = (testId: string): string => (screen.getByTestId(testId) as HTMLInputElement).labels?.[0]?.textContent ?? '';
    const english = ['timeline-clip-scale-x', 'timeline-clip-scale-y', 'timeline-clip-rotation'].map(labelOf);
    for (const text of english) expect(text).not.toBe('');
    act(() => { setLocale('ja'); });
    const japanese = ['timeline-clip-scale-x', 'timeline-clip-scale-y', 'timeline-clip-rotation'].map(labelOf);
    japanese.forEach((text, index) => expect(text, english[index]).not.toBe(english[index]));
    act(() => { setLocale('en'); });
  });

  describe('field errors name what each field takes', () => {
    it.each([
      ['timeline-clip-scale-x', 'abc'], ['timeline-clip-scale-x', '0'], ['timeline-clip-scale-x', '20000'],
      ['timeline-clip-scale-y', 'abc'], ['timeline-clip-scale-y', '0'], ['timeline-clip-scale-y', '20000'],
    ] as const)('shows the scale range beside %s for "%s"', (testId, typed) => {
      const onCommit = showPlaced();
      typeAndEnter(testId, typed);
      expect(onCommit).not.toHaveBeenCalled();
      const range = { min: TIMELINE_LAYER_TRANSFORM_LIMITS.scale.min * 100, max: TIMELINE_LAYER_TRANSFORM_LIMITS.scale.max * 100 };
      expect(t('timeline.errors.scaleRange', range)).toBe('Enter 1 to 10000.');
      expect(noteBeside(testId)).toBe(true);
      expect(screen.getByTestId('timeline-clip-field-error')).toHaveTextContent('Enter 1 to 10000.');
    });

    it.each(['timeline-clip-x', 'timeline-clip-y', 'timeline-clip-rotation'] as const)('asks for a number beside %s for "abc"', (testId) => {
      const onCommit = showPlaced();
      typeAndEnter(testId, 'abc');
      expect(onCommit).not.toHaveBeenCalled();
      expect(t('timeline.errors.notNumber')).toBe('Enter a number.');
      expect(noteBeside(testId)).toBe(true);
      expect(screen.getByTestId('timeline-clip-field-error')).toHaveTextContent('Enter a number.');
    });
  });

  it('labels the position fields in canvas pixels', () => {
    showPlaced();
    const labelOf = (testId: string): string => (screen.getByTestId(testId) as HTMLInputElement).labels?.[0]?.textContent ?? '';
    expect(labelOf('timeline-clip-x')).toBe('X (px)');
    expect(labelOf('timeline-clip-y')).toBe('Y (px)');
  });

  describe('the ratio lock switch', () => {
    const HALF = clip(cid(25), V2, 10, 14, { transform: { x: 10, y: 20, scaleX: 0.5, scaleY: 0.25, rotation: 5 } });

    it('is a switch labelled Lock ratio, on by default, after the Rotation field and last in the group', () => {
      showPlaced();
      const lock = screen.getByTestId('timeline-clip-lock-ratio');
      expect(lock).toHaveAttribute('role', 'switch');
      expect(lock).toHaveAttribute('aria-checked', 'true');
      expect(lock).toHaveAttribute('data-state', 'checked');
      expect(screen.getByRole('switch', { name: 'Lock ratio' })).toBe(lock);
      expect(screen.getByText('Lock ratio')).toBeVisible();
      const follows = (earlier: Element, later: Element): boolean => (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      expect(follows(screen.getByTestId('timeline-clip-rotation'), lock)).toBe(true);
      // The source line follows the group, so nothing of the group comes after the lock.
      expect(follows(lock, screen.getByTestId('timeline-clip-source'))).toBe(true);
    });

    it('turns off from its text label, and then a scale edit changes only its own axis', () => {
      const onCommit = showPlaced(HALF);
      fireEvent.click(screen.getByText('Lock ratio'));
      const lock = screen.getByTestId('timeline-clip-lock-ratio');
      expect(lock).toHaveAttribute('aria-checked', 'false');
      expect(lock).toHaveAttribute('data-state', 'unchecked');
      typeAndEnter('timeline-clip-scale-x', '100');
      expect(onCommit).toHaveBeenLastCalledWith(setTransform({ x: 10, y: 20, scaleX: 1, scaleY: 0.25, rotation: 5 }, HALF.id));
      typeAndEnter('timeline-clip-scale-y', '50');
      expect(onCommit).toHaveBeenLastCalledWith(setTransform({ x: 10, y: 20, scaleX: 0.5, scaleY: 0.5, rotation: 5 }, HALF.id));
    });

    it('carries the other axis again once switched back on', () => {
      const onCommit = showPlaced(HALF);
      const lock = screen.getByTestId('timeline-clip-lock-ratio');
      fireEvent.click(lock);
      fireEvent.click(lock);
      expect(lock).toHaveAttribute('aria-checked', 'true');
      typeAndEnter('timeline-clip-scale-x', '100');
      expect(onCommit).toHaveBeenLastCalledWith(setTransform({ x: 10, y: 20, scaleX: 1, scaleY: 0.5, rotation: 5 }, HALF.id));
    });
  });

  describe('the off-frame note', () => {
    const NOTE = 'This clip is not at the current frame.';

    it('shows the note in the group when the clip is not at the current frame', () => {
      showPlaced(PLACED, false, false);
      expect(screen.getByTestId('timeline-clip-off-frame')).toHaveTextContent(NOTE);
      expect(screen.getByTestId('timeline-clip-x')).toBeInstanceOf(HTMLInputElement);
    });

    it('shows no note when the clip is at the current frame', () => {
      showPlaced(PLACED, false, true);
      expect(screen.getByTestId('timeline-clip-x')).toBeInTheDocument();
      expect(screen.queryByTestId('timeline-clip-off-frame')).toBe(null);
      expect(screen.queryByText(NOTE)).toBe(null);
    });

    it('shows no note for an upload placeholder, which has no position and size group', () => {
      showPlaced(uploadClip(cid(26), V2, 0), false, false);
      expect(screen.queryByTestId('timeline-clip-x')).toBe(null);
      expect(screen.queryByTestId('timeline-clip-off-frame')).toBe(null);
    });
  });
});
