// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * #1474: inserting a camera command leaves the caret where the insert put it, in the prompt, whichever of the
 * editor's focus and the popover's close runs last; closing the popover any other way gives focus back to its pill.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CameraCommandPicker } from '@web/spaces/canvas/generate/CameraCommandPicker';

const COMMANDS = [{ name: 'Pan left', preview: 'https://example.test/pan-left.mp4' }] as never;

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The picker beside a box standing in for the prompt editor, which takes focus a frame after a command is inserted,
 * as TipTap's `focus()` does.
 * @returns The box.
 */
function renderPicker(): HTMLInputElement {
  render(
    <>
      <input data-testid='prompt' />
      <CameraCommandPicker
        commands={COMMANDS}
        onInsert={() => requestAnimationFrame(() => (screen.getByTestId('prompt') as HTMLInputElement).focus())}
      />
    </>,
  );
  return screen.getByTestId('prompt') as HTMLInputElement;
}

describe('CameraCommandPicker focus on close', () => {
  it('leaves focus in the prompt an insert moved it to, even when the editor takes it before the popover closes', async () => {
    // The order that lost the caret (#1474): the editor's frame runs before the popover's close timer.
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(() => run(0), 0));
    const prompt = renderPicker();
    fireEvent.click(screen.getByTestId('generate-video-camera-trigger'));
    fireEvent.click(await screen.findByTestId('generate-video-camera-option-pan-left'));
    const content = screen.getByTestId('generate-video-camera-insert').closest('[data-state]') as HTMLElement;
    fireEvent.click(screen.getByTestId('generate-video-camera-insert'));
    // jsdom runs no animations: end the close animation so the popover unmounts, then let the timer that hands
    // focus back run.
    fireEvent.animationEnd(content);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId('generate-video-camera-insert')).toBeNull();
    expect(document.activeElement).toBe(prompt);
  });

  it('gives focus back to the pill when closed without inserting', async () => {
    renderPicker();
    const trigger = screen.getByTestId('generate-video-camera-trigger');
    fireEvent.click(trigger);
    await screen.findByTestId('generate-video-camera-insert');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
