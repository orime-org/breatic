// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video focus crop, the bar under a source with no selected version (frames-split design §5.5 "界面状态", §7.12; test plan
 * §68.1 F04). The source video follows the one panel derivation the seven video tools use: while it is preparing the bar
 * says so and Confirm cannot be pressed; a temporary failure offers the existing retry; a content failure says the video
 * cannot be used.
 *
 * The bar is told the source's state through a proposed `sourceState` prop (the derivation's own vocabulary) and
 * `onRetrySource`; the proposed test ids are listed in the report. The props are passed through a widened component type,
 * so the file typechecks while the behaviour is missing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { FocusCropControls } from '@web/spaces/canvas/focus/FocusCropControls';
import { canvasSessions } from '@web/stores/canvas-session';
import { cropCanvas, draw, installLayout, type MediaNodeData } from '@web/spaces/canvas/crop/__tests__/crop-harness';

type SourceState = 'waiting-presentation' | 'retryable' | 'unsupported' | 'usable';
const Bar = FocusCropControls as unknown as React.FC<{
  onConfirm: () => boolean;
  onBackToPick: () => void;
  sourceState: SourceState;
  onRetrySource: () => void;
}>;
const VIDEO: { id: string } & MediaNodeData = { id: 'n1', kind: 'video', src: 'https://cdn/clip.mp4' };

/**
 * Render the bar on a picked video whose metadata has arrived, with a valid marquee drawn.
 * @param sourceState - The source's derived state.
 * @returns The spies.
 */
function renderBar(sourceState: SourceState): { onConfirm: ReturnType<typeof vi.fn>; onRetrySource: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn(() => true);
  const onRetrySource = vi.fn();
  render(cropCanvas([VIDEO], <Bar onConfirm={onConfirm} onBackToPick={vi.fn()} sourceState={sourceState} onRetrySource={onRetrySource} />));
  const video = screen.getByTestId('media-element') as HTMLVideoElement;
  Object.defineProperty(video, 'duration', { configurable: true, get: () => 10 });
  Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 4, set: () => undefined });
  Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => 600 });
  act(() => {
    const store = canvasSessions.of('').getState();
    store.startFocusPick('host');
    store.setFocusTarget({ nodeId: VIDEO.id, content: VIDEO.src });
  });
  draw({ x: 150, y: 100 }, { x: 250, y: 180 });
  return { onConfirm, onRetrySource };
}

beforeEach(() => { installLayout(); canvasSessions.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('F04: the focus bar while the source video has no selected version (design §5.5, §7.12)', () => {
  it('F04: preparing shows the waiting state and Confirm cannot be pressed', () => {
    const { onConfirm } = renderBar('waiting-presentation');
    expect(screen.getByTestId('focus-crop-source-waiting')).toBeInTheDocument();
    const confirm = screen.getByTestId('focus-crop-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('F04: a temporary failure shows the failure with the existing retry', () => {
    const { onConfirm, onRetrySource } = renderBar('retryable');
    fireEvent.click(screen.getByTestId('focus-crop-source-retry'));
    expect(onRetrySource).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('F04: a content failure shows the video as unusable, with no retry', () => {
    const { onConfirm } = renderBar('unsupported');
    expect(screen.getByTestId('focus-crop-source-unsupported')).toBeInTheDocument();
    expect(screen.queryByTestId('focus-crop-source-retry')).toBeNull();
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('F04: a usable source shows none of the three and confirms as before', () => {
    const { onConfirm } = renderBar('usable');
    expect(screen.queryByTestId('focus-crop-source-waiting')).toBeNull();
    expect(screen.queryByTestId('focus-crop-source-unsupported')).toBeNull();
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
