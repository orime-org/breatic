// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Space hidden while the voice list is fetching its next page is shown
 * again with that request still out (inner#1235 §5.5 C12). Showing it must not
 * send the same page again, and the page must land once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import * as React from 'react';
import type { VoicePage } from '@breatic/shared';

const list = vi.fn();
vi.mock('@web/data/api/voices', () => ({
  voicesApi: {
    list: (...args: unknown[]) => list(...args),
  },
}));

import {
  useVoiceList,
  type VoiceListHandle,
} from '@web/spaces/canvas/generate/use-voice-list';

let handle: VoiceListHandle | null = null;

/**
 * Exposes the hook to the test.
 * @returns Nothing visible.
 */
function Probe(): null {
  handle = useVoiceList('elevenlabs-v3');
  return null;
}

/**
 * Renders the probe in an Activity of the given mode.
 * @param mode - Whether the Space is shown.
 * @returns The element.
 */
function inSpace(mode: 'visible' | 'hidden'): React.JSX.Element {
  return (
    <React.Activity mode={mode}>
      <Probe />
    </React.Activity>
  );
}

beforeEach(() => {
  list.mockReset();
  handle = null;
});

describe('useVoiceList across a hide', () => {
  it('sends the next page once and lands it once', async () => {
    const first: VoicePage = {
      voices: [{ id: 'Alice', name: 'Alice' }],
      hasMore: true,
      nextCursor: 'c1',
    };
    let landNext: (p: VoicePage) => void = () => {};
    list.mockResolvedValueOnce(first);
    list.mockImplementationOnce(
      () =>
        new Promise<VoicePage>((resolve) => {
          landNext = resolve;
        }),
    );
    list.mockResolvedValue({ voices: [], hasMore: false });

    const { rerender } = render(inSpace('visible'));
    act(() => handle?.onOpenChange(true));
    await waitFor(() => expect(handle?.state.status).toBe('ready'));
    act(() => handle?.onLoadMore());
    expect(list).toHaveBeenCalledTimes(2);

    await act(async () => {
      rerender(inSpace('hidden'));
    });
    await act(async () => {
      rerender(inSpace('visible'));
    });
    await act(async () => {
      landNext({ voices: [{ id: 'Aria', name: 'Aria' }], hasMore: false });
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(handle?.state.voices.map((v) => v.id)).toEqual(['Alice', 'Aria']);
  });
});
