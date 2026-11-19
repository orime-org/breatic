// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 (canvas design §4 转场行; §10 editor row; demo 2026-10-23-1306-video-tools `timeline-editor.tsx`):
 * a non-Cut transition lasts between the bounds shared `transitionDurationBounds(clips, fps)` answers. When it answers null
 * only Cut is usable: Crossfade, Wipe left and Wipe right stay listed with `aria-disabled` and a click explains with a toast
 * (`canvas.miniTool.videoUI.transitionTooShort`). The four types read their locale names (`transitionCut`, `transitionFade`,
 * `transitionWipeLeft`, `transitionWipeRight`). The duration input clamps what is typed into `[min, max]`. The shared function
 * is mocked so the bounds decide each case; the fps it is asked with is the first clip's rate, read off that clip's selected
 * compact presentation table (D13-1). `inputTables` (input id to compact table) is a Dialog prop this test chose.
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
import type { VideoPresentationTable, VideoToolDraftById, VideoToolTimelineClip } from '@breatic/shared/mini-tools';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@breatic/shared/mini-tools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  transitionDurationBounds: vi.fn(),
}));
// The track editor and the GL preview are not under test; jsdom cannot draw either.
vi.mock('@xzdarcy/react-timeline-editor', async () => ({ Timeline: (await import('react')).forwardRef(() => null) }));
vi.mock('@web/spaces/canvas/mini-tool/video/VideoTimelinePreview', () => ({ VideoTimelinePreview: () => null }));

import * as miniTools from '@breatic/shared/mini-tools';
import { toast } from '@web/lib/toast';
import { VideoTimelineDialog } from '../video/VideoTimelineDialog';

type Bounds = { min: number; max: number } | null;
const bounds = vi.mocked((miniTools as unknown as { transitionDurationBounds: (clips: readonly VideoToolTimelineClip[], fps: { numerator: string; denominator: string }) => Bounds }).transitionDurationBounds);

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/a.mp4', mediaInfo: { width: 960, height: 540, duration: 6, mimeType: 'video/mp4' } };
const inputA = { inputId: '60000000-0000-4000-8000-000000000001', url: source.canonicalURL, mediaInfo: source.mediaInfo, sourceNodeId: source.nodeId };
const inputB = { inputId: '60000000-0000-4000-8000-000000000002', url: 'https://media.example.test/b.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
// Each input's selected compact table: A runs at 30000/1001 fps, B at 25 fps, so neither a default rate nor the other clip's passes.
const TABLE_NTSC: VideoPresentationTable = { schemaVersion: 1, timescale: 30000, runs: [{ start: 0, count: 180, step: 1001, duration: 1001 }] };
const TABLE_PAL: VideoPresentationTable = { schemaVersion: 1, timescale: 100, runs: [{ start: 0, count: 125, step: 4, duration: 4 }] };
const inputTables = new Map([[inputA.inputId, TABLE_NTSC], [inputB.inputId, TABLE_PAL]]);
const TYPE_KEYS = ['transitionCut', 'transitionFade', 'transitionWipeLeft', 'transitionWipeRight'] as const;

/**
 * Whether two rationals are the same number, without assuming either is reduced.
 * @param a - One rational.
 * @param b - The other.
 * @returns Whether they are equal.
 */
function sameRate(a: { numerator: string; denominator: string }, b: { numerator: string; denominator: string }): boolean {
  return BigInt(a.numerator) * BigInt(b.denominator) === BigInt(b.numerator) * BigInt(a.denominator);
}

/**
 * A two-clip draft of 4 s then 3 s, long enough that only the mocked bounds can refuse a transition.
 * @param kind - The transition after the first clip.
 * @param duration - Its length in seconds.
 * @returns The draft.
 */
function draftWith(kind: VideoToolTimelineClip['transition']['kind'], duration: number): VideoToolDraftById['video.transitions'] {
  return {
    version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [inputA, inputB],
    params: { clips: [
      { clipId: '50000000-0000-4000-8000-000000000001', inputId: inputA.inputId, in: 1, out: 5, transition: { kind, duration } },
      { clipId: '50000000-0000-4000-8000-000000000002', inputId: inputB.inputId, in: 0, out: 3, transition: { kind: 'cut', duration: 0 } },
    ] },
  };
}

/**
 * Mounts the open Dialog on a draft.
 * @param draft - The draft shown.
 * @param onChange - Receives every committed edit.
 * @returns Nothing.
 */
function open(draft: VideoToolDraftById['video.transitions'], onChange: (next: VideoToolDraftById['video.transitions']) => void): void {
  const proposed: object = { inputTables };
  render(<VideoTimelineDialog open onOpenChange={vi.fn()} draft={draft} onChange={onChange} inputNames={new Map([[inputA.inputId, 'A'], [inputB.inputId, 'B']])} disabled={false} onRun={vi.fn()} {...proposed} />);
}

/**
 * Opens the transition type list and returns its options in display order (Cut, Crossfade, Wipe left, Wipe right).
 * @param user - The user-event session.
 * @returns The four options.
 */
async function transitionOptions(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement[]> {
  // The clip selector reads "1. A"; the other combobox is the transition type.
  const trigger = screen.getAllByRole('combobox').find((box) => !/^\d+\./.test(box.textContent ?? ''));
  if (trigger === undefined) throw new Error('No transition type control');
  await user.click(trigger);
  const options = await screen.findAllByRole('option');
  expect(options).toHaveLength(4);
  return options;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('transition types follow the shared duration bounds (§97; canvas design §4 转场)', () => {
  it('keeps Crossfade, Wipe left and Wipe right listed but aria-disabled when the bounds are null, Cut usable', async () => {
    bounds.mockReturnValue(null);
    const user = userEvent.setup();
    open(draftWith('cut', 0), vi.fn());
    const [cut, ...others] = await transitionOptions(user);
    expect(cut).not.toHaveAttribute('aria-disabled', 'true');
    for (const option of others) {
      expect(option).toHaveAttribute('aria-disabled', 'true');
      // aria-disabled, not Radix `disabled`: the click must still reach the toast.
      expect(option).not.toHaveAttribute('data-disabled');
    }
    expect(bounds).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ clipId: '50000000-0000-4000-8000-000000000001' })]), expect.objectContaining({ numerator: expect.anything(), denominator: expect.anything() }));
  });

  it('explains with a toast and commits nothing when a refused type is clicked', async () => {
    bounds.mockReturnValue(null);
    const user = userEvent.setup();
    const onChange = vi.fn();
    open(draftWith('cut', 0), onChange);
    const options = await transitionOptions(user);
    await user.click(options[2]);
    expect(toast.warning).toHaveBeenCalledWith(t('canvas.miniTool.videoUI.transitionTooShort'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves every type usable when the bounds exist', async () => {
    bounds.mockReturnValue({ min: 0.2, max: 1.2 });
    const user = userEvent.setup();
    open(draftWith('cut', 0), vi.fn());
    for (const option of await transitionOptions(user)) expect(option).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('names the four types through their locale keys', async () => {
    bounds.mockReturnValue({ min: 0.2, max: 1.2 });
    const user = userEvent.setup();
    open(draftWith('cut', 0), vi.fn());
    expect((await transitionOptions(user)).map((option) => option.textContent)).toEqual(TYPE_KEYS.map((key) => t(`canvas.miniTool.videoUI.${key}`)));
  });

  it.each([
    ['A (30000/1001 fps) first', false, { numerator: '30000', denominator: '1001' }],
    ['B (25 fps) first', true, { numerator: '25', denominator: '1' }],
  ])('asks for the bounds at the first clip rate read off its compact table: %s', (_name, swapped, rate) => {
    bounds.mockReturnValue({ min: 0.2, max: 1.2 });
    const draft = draftWith('fade', 0.5);
    open(swapped ? { ...draft, params: { clips: [{ ...draft.params.clips[1], transition: draft.params.clips[0].transition }, { ...draft.params.clips[0], transition: { kind: 'cut', duration: 0 } }] } } : draft, vi.fn());
    expect(bounds).toHaveBeenCalled();
    for (const [, fps] of bounds.mock.calls) {
      expect(fps).toEqual({ numerator: expect.any(String), denominator: expect.any(String) });
      expect(sameRate(fps, rate), `${fps.numerator}/${fps.denominator}`).toBe(true);
    }
  });
});

describe('an edit inside the Dialog keeps the chosen type and clamps its length to the new bounds (canvas design §4 转场)', () => {
  /**
   * The two-clip draft with a shorter second clip; the real shared bounds of the Dialog's normalisation decide here.
   * @param out - Where B's clip ends.
   * @returns The draft with a 1.4 s Crossfade.
   */
  function shortened(out: number): VideoToolDraftById['video.transitions'] {
    const draft = draftWith('fade', 1.4);
    return { ...draft, params: { clips: [draft.params.clips[0], { ...draft.params.clips[1], out }] } };
  }

  it('an edit over a 2 s second clip keeps Crossfade at half that clip', async () => {
    bounds.mockReturnValue({ min: 0.2, max: 1 });
    const user = userEvent.setup();
    const onChange = vi.fn();
    open(shortened(2), onChange);
    await user.click(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.swapClips') }));
    const last = onChange.mock.calls.at(-1)![0] as VideoToolDraftById['video.transitions'];
    expect(last.params.clips[0].transition).toEqual({ kind: 'fade', duration: 1 });
  });
});

describe('the transition duration input clamps to the shared bounds (§97; canvas design §4 转场)', () => {
  it.each([
    ['above the maximum', '5', 1.2],
    ['below the minimum', '0.05', 0.2],
  ])('shows a value %s as refused while typed, then commits and shows the nearest bound on leaving the field', (_name, typed, committed) => {
    bounds.mockReturnValue({ min: 0.2, max: 1.2 });
    const onChange = vi.fn();
    open(draftWith('fade', 0.5), onChange);
    const field = screen.getByTestId('video-clip-overlap');
    fireEvent.change(field, { target: { value: typed } });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(field).toHaveValue(String(committed));
    const last = onChange.mock.calls.at(-1)![0] as VideoToolDraftById['video.transitions'];
    expect(last.params.clips[0].transition).toEqual({ kind: 'fade', duration: committed });
  });

  /**
   * The open Dialog over its own draft state, so each commit comes back as the next draft.
   * @param props - The first draft.
   * @param props.initial - The draft first shown.
   * @returns The Dialog.
   */
  function StatefulDialog(props: { initial: VideoToolDraftById['video.transitions'] }): React.JSX.Element {
    const [draft, setDraft] = React.useState(props.initial);
    const proposed: object = { inputTables };
    return <VideoTimelineDialog open onOpenChange={vi.fn()} draft={draft} onChange={setDraft} inputNames={new Map([[inputA.inputId, 'A'], [inputB.inputId, 'B']])} disabled={false} onRun={vi.fn()} {...proposed} />;
  }

  it('keeps every key of a duration typed key by key that starts below the minimum', async () => {
    bounds.mockReturnValue({ min: 0.2, max: 1.2 });
    const user = userEvent.setup();
    render(<StatefulDialog initial={draftWith('fade', 1)} />);
    await user.tripleClick(screen.getByTestId('video-clip-overlap'));
    await user.keyboard('0.5');
    expect(screen.getByTestId('video-clip-overlap')).toHaveValue('0.5');
    expect(screen.getByTestId('video-clip-overlap')).toHaveAttribute('aria-invalid', 'false');
  });

  it.each([
    // One output frame of the first clip's 30000/1001 fps, the minimum the Dialog's own normalisation also holds to.
    ['the minimum up', { min: 1001 / 30000, max: 1.5 }, '0.01', '0.033367'],
    ['the maximum down', { min: 0.04, max: 1 / 3 }, '5', '0.333333'],
  ])('takes %s to a whole microsecond inside the bounds when it clamps', (_name, limits, typed, shown) => {
    bounds.mockReturnValue(limits);
    render(<StatefulDialog initial={draftWith('fade', 0.2)} />);
    const field = screen.getByTestId('video-clip-overlap');
    fireEvent.change(field, { target: { value: typed } });
    fireEvent.blur(field);
    expect(field).toHaveValue(shown);
    expect(field).toHaveAttribute('aria-invalid', 'false');
  });

  it('fits the transition held since an Out began to be typed to each key, so a key on the way does not shorten it for good', async () => {
    bounds.mockReturnValue({ min: 0.04, max: 1.5 });
    const user = userEvent.setup();
    render(<StatefulDialog initial={draftWith('fade', 1.4)} />);
    // The first clip runs 1 s to 5 s; typing Out 2.9 passes through Out 2, a 1 s clip that holds at most a 0.5 s transition.
    await user.tripleClick(screen.getByTestId('video-clip-out'));
    await user.keyboard('2');
    expect(Number((screen.getByTestId('video-clip-overlap') as HTMLInputElement).value)).toBeLessThan(0.6);
    await user.keyboard('.9');
    expect(screen.getByTestId('video-clip-out')).toHaveFocus();
    expect(Number((screen.getByTestId('video-clip-overlap') as HTMLInputElement).value)).toBeGreaterThan(0.9);
    await user.keyboard('{Enter}');
    // A new entry holds the transition as it now is.
    await user.tripleClick(screen.getByTestId('video-clip-out'));
    await user.keyboard('5');
    expect(Number((screen.getByTestId('video-clip-overlap') as HTMLInputElement).value)).toBeLessThan(1);
  });

  it('shows a duration the Dialog re-fits to a shorter clip on the whole-microsecond grid', async () => {
    bounds.mockReturnValue({ min: 0.04, max: 1.5 });
    const user = userEvent.setup();
    render(<StatefulDialog initial={draftWith('fade', 1.4)} />);
    // Out 2.85 leaves the first clip 1.85 s, which holds at most half of it on the 30000/1001 frame grid.
    await user.tripleClick(screen.getByTestId('video-clip-out'));
    await user.keyboard('2.85{Enter}');
    expect((screen.getByTestId('video-clip-overlap') as HTMLInputElement).value).toMatch(/^\d+(\.\d{1,6})?$/);
  });

  it('shows the nearest whole microsecond when no whole microsecond lies between the bounds of a two-frame clip', () => {
    bounds.mockReturnValue({ min: 1001 / 30000, max: 1001 / 30000 });
    render(<StatefulDialog initial={draftWith('fade', 0.2)} />);
    const field = screen.getByTestId('video-clip-overlap');
    fireEvent.change(field, { target: { value: '0.5' } });
    fireEvent.blur(field);
    expect(field).toHaveValue('0.033367');
    expect(field).toHaveAttribute('aria-invalid', 'false');
  });

  it('shows the stored bound when the clamp lands on a bound the length already holds', () => {
    bounds.mockReturnValue({ min: 0.04, max: 1 / 3 });
    render(<StatefulDialog initial={draftWith('fade', 0.333333)} />);
    const field = screen.getByTestId('video-clip-overlap');
    fireEvent.change(field, { target: { value: '5' } });
    fireEvent.blur(field);
    expect(field).toHaveValue('0.333333');
  });

  it('clamps an out-of-range length when Tab is pressed, while the field still holds the focus', () => {
    bounds.mockReturnValue({ min: 0.2, max: 1.2 });
    render(<StatefulDialog initial={draftWith('fade', 0.5)} />);
    const field = screen.getByTestId('video-clip-overlap');
    act(() => field.focus());
    fireEvent.change(field, { target: { value: '9' } });
    fireEvent.keyDown(field, { key: 'Tab' });
    expect(field).toHaveFocus();
    expect(field).toHaveValue('1.2');
    expect(field).toHaveAttribute('aria-invalid', 'false');
  });

  it('re-fits from the transition the user last set when an In write happened outside an entry', async () => {
    bounds.mockReturnValue({ min: 0.04, max: 1.5 });
    const user = userEvent.setup();
    let setFromOutside: (next: VideoToolDraftById['video.transitions']) => void = () => undefined;
    /**
     * The Dialog over its own draft, which the test can also replace as another edit would.
     * @returns The Dialog.
     */
    function Outside(): React.JSX.Element {
      const [draft, setDraft] = React.useState(draftWith('fade', 1));
      setFromOutside = setDraft;
      const proposed: object = { inputTables };
      return <VideoTimelineDialog open onOpenChange={vi.fn()} draft={draft} onChange={setDraft} inputNames={new Map([[inputA.inputId, 'A'], [inputB.inputId, 'B']])} disabled={false} onRun={vi.fn()} {...proposed} />;
    }
    render(<Outside />);
    // Out 6.5 is refused past the 6 s source; the source then reads as 8 s elsewhere, so the Out writes itself without an entry.
    fireEvent.change(screen.getByTestId('video-clip-out'), { target: { value: '6.5' } });
    fireEvent.blur(screen.getByTestId('video-clip-out'));
    const longer = draftWith('fade', 1);
    act(() => setFromOutside({ ...longer, inputs: [{ ...inputA, mediaInfo: { ...inputA.mediaInfo, duration: 8 } }, inputB] }));
    expect(screen.getByTestId('video-clip-out')).toHaveAttribute('aria-invalid', 'false');
    // The user then sets the length to 0.3 and types a new In.
    await user.tripleClick(screen.getByTestId('video-clip-overlap'));
    await user.keyboard('0.3{Enter}');
    await user.tripleClick(screen.getByTestId('video-clip-in'));
    await user.keyboard('2{Enter}');
    expect(Number((screen.getByTestId('video-clip-overlap') as HTMLInputElement).value)).toBeCloseTo(0.3, 2);
  });

  it('shows the bound it commits when the stored duration already sits at that bound', () => {
    bounds.mockReturnValue({ min: 0.2, max: 1.2 });
    render(<StatefulDialog initial={draftWith('fade', 1.2)} />);
    const field = screen.getByTestId('video-clip-overlap');
    fireEvent.change(field, { target: { value: '3' } });
    fireEvent.blur(field);
    expect(field).toHaveValue('1.2');
    expect(field).toHaveAttribute('aria-invalid', 'false');
  });
});

describe('the clip settings say the lengths the bounds come from (demo transition-duration-limit state)', () => {
  it('shows the selected clip\'s source length and trimmed length', () => {
    bounds.mockReturnValue({ min: 0.2, max: 1.5 });
    open(draftWith('fade', 1), vi.fn());
    expect(screen.getByTestId('video-clip-lengths').textContent).toBe(`${t('canvas.miniTool.videoUI.sourceDuration')}: 6.00 s${t('canvas.miniTool.videoUI.clipDuration')}: 4.00 s`);
  });

  it('states the longest transition the clips allow under the duration field', () => {
    bounds.mockReturnValue({ min: 0.2, max: 1.5 });
    open(draftWith('fade', 1), vi.fn());
    expect(screen.getByText(t('canvas.miniTool.videoUI.overlapLimit', { limit: '1.50 s' }))).toBeInTheDocument();
  });
});
