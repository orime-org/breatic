// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A failed presentation read in the tool panel (frames-split §7.12 step 1): with no response held, the panel offers the
 * existing Retry, which rereads the source, instead of waiting on "Preparing video…" with nothing to press.
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCanvasVideoBindings } from '../use-canvas-video-bindings';

const url = 'https://assets.example.test/video/source.mp4';

describe('the panel over a failed presentation read (§7.12 step 1)', () => {
  it('RF01 publishes a retryable state marked as a read failure, with the source Retry', () => {
    const onRetry = vi.fn();
    const { result } = renderHook(() => useCanvasVideoBindings('node-1', url, { response: undefined, readFailed: true, retrying: false, onRetry, previewSource: null }));
    const shown = result.current.presentations.get('node-1');
    expect(shown?.panelState).toBe('retryable');
    expect(shown?.readFailed).toBe(true);
    shown?.onRetry?.();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('RF02 a read still in flight waits for the presentation', () => {
    const { result } = renderHook(() => useCanvasVideoBindings('node-1', url, { response: undefined, readFailed: false, retrying: false, onRetry: vi.fn(), previewSource: null }));
    expect(result.current.presentations.get('node-1')?.panelState).toBe('waiting-presentation');
    expect(result.current.presentations.get('node-1')?.readFailed).toBe(false);
  });
});
