// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A node measures its picture once, on load; the image does not load again
 * when its Space is shown after a hide (inner#1235 §5.5 C10). The measured
 * size has to survive the hide, or the badge goes blank.
 */

import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import * as React from 'react';

import { useNodeResolution } from '@web/spaces/canvas/nodes/_shared/useNodeResolution';

/**
 * Shows the resolution a node would badge.
 * @returns The probe.
 */
function ResolutionProbe(): React.JSX.Element {
  const { resolution, setResolution } = useNodeResolution('https://example.test/a.png');
  return (
    <button
      type='button'
      data-testid='resolution'
      onClick={() => setResolution({ width: 640, height: 480 })}
    >
      {resolution ? `${resolution.width}x${resolution.height}` : 'none'}
    </button>
  );
}

describe('a measured resolution across a hide', () => {
  it('is still there when the Space is shown again', async () => {
    const { rerender } = render(
      <React.Activity mode='visible'>
        <ResolutionProbe />
      </React.Activity>,
    );
    await act(async () => {
      screen.getByTestId('resolution').click();
    });
    expect(screen.getByTestId('resolution').textContent).toBe('640x480');

    await act(async () => {
      rerender(
        <React.Activity mode='hidden'>
          <ResolutionProbe />
        </React.Activity>,
      );
    });
    await act(async () => {
      rerender(
        <React.Activity mode='visible'>
          <ResolutionProbe />
        </React.Activity>,
      );
    });

    expect(screen.getByTestId('resolution').textContent).toBe('640x480');
  });
});
