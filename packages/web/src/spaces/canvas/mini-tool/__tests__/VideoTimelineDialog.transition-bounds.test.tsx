// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
import { fireEvent, render, screen } from '@testing-library/react';
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
  ])('commits the nearest bound for a value %s', (_name, typed, committed) => {
    bounds.mockReturnValue({ min: 0.2, max: 1.2 });
    const onChange = vi.fn();
    open(draftWith('fade', 0.5), onChange);
    fireEvent.change(screen.getByTestId('video-clip-overlap'), { target: { value: typed } });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0] as VideoToolDraftById['video.transitions'];
    expect(last.params.clips[0].transition).toEqual({ kind: 'fade', duration: committed });
  });
});
