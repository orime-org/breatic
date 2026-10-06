// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Space switched away from is hidden, not unmounted (inner#1235 A5): what
 * it was playing must stop, and the controls must say so when it comes back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import * as React from 'react';

import { useSamplePlayer } from '@web/spaces/canvas/generate/use-sample-player';
import { useMediaPlayer } from '@web/spaces/canvas/nodes/_shared/useMediaPlayer';

const pauseSpy = vi.fn();

beforeEach(() => {
  pauseSpy.mockReset();
  vi.stubGlobal(
    'Audio',
    class {
      addEventListener(): void {}
      pause(): void {
        pauseSpy();
      }
      play(): Promise<void> {
        return Promise.resolve();
      }
    },
  );
});

/**
 * A voice row that plays one sample.
 * @returns The probe.
 */
function SampleRow(): React.JSX.Element {
  const player = useSamplePlayer();
  return (
    <button
      type='button'
      data-testid='sample'
      onClick={() => player.toggle('voice-1', 'https://example.test/a.mp3')}
    >
      {player.playing ?? 'idle'}
    </button>
  );
}

/**
 * A video with the shared player hook on it.
 * @returns The probe.
 */
function VideoProbe(): React.JSX.Element {
  const ref = React.useRef<HTMLVideoElement>(null);
  useMediaPlayer(ref);
  return (
    <video ref={ref} data-testid='video'>
      <track kind='captions' />
    </video>
  );
}

describe('hiding a Space stops what it plays', () => {
  it('stops a voice sample and shows the row as idle', async () => {
    const { rerender } = render(
      <React.Activity mode='visible'>
        <SampleRow />
      </React.Activity>,
    );
    await act(async () => {
      screen.getByTestId('sample').click();
    });
    expect(screen.getByTestId('sample').textContent).toBe('voice-1');

    await act(async () => {
      rerender(
        <React.Activity mode='hidden'>
          <SampleRow />
        </React.Activity>,
      );
    });
    expect(pauseSpy).toHaveBeenCalled();

    await act(async () => {
      rerender(
        <React.Activity mode='visible'>
          <SampleRow />
        </React.Activity>,
      );
    });
    expect(screen.getByTestId('sample').textContent).toBe('idle');
  });

  it('pauses a video in the hidden Space', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { rerender } = render(
      <React.Activity mode='visible'>
        <VideoProbe />
      </React.Activity>,
    );

    await act(async () => {
      rerender(
        <React.Activity mode='hidden'>
          <VideoProbe />
        </React.Activity>,
      );
    });

    expect(pause).toHaveBeenCalled();
    pause.mockRestore();
  });
});
