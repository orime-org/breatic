// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 — the state every Generate panel reads at click time.
 *
 * Three containers kept a byte-identical copy of this. The behaviour it has to
 * keep: the prompt is readable synchronously, a second click cannot get past
 * the latch before state catches up, and a submit started by a mount that has
 * since gone away can tell that it has.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useGenerateSubmitState } from '@web/spaces/canvas/generate/use-generate-submit-state';

describe('useGenerateSubmitState', () => {
  it('starts with an empty prompt, not submitting, and mounted', () => {
    const { result } = renderHook(() => useGenerateSubmitState());

    expect(result.current.promptText).toBe('');
    expect(result.current.promptTextRef.current).toBe('');
    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.submittingRef.current).toBe(false);
    expect(result.current.isMountedRef.current).toBe(true);
    expect(result.current.promptEditorRef.current).toBeNull();
  });

  // The ref is what the click handler reads: state lags a frame, and a rapid
  // re-click or a collaborator keystroke React has batched would otherwise
  // submit the previous text.
  it('writes a prompt change to the ref before React has re-rendered', () => {
    const { result } = renderHook(() => useGenerateSubmitState());

    const before = result.current;
    before.onPromptChange('a cat');

    expect(before.promptTextRef.current).toBe('a cat');
  });

  it('carries the prompt into state as well', () => {
    const { result } = renderHook(() => useGenerateSubmitState());

    act(() => {
      result.current.onPromptChange('a cat');
    });

    expect(result.current.promptText).toBe('a cat');
  });

  it('keeps one prompt-change callback across renders', () => {
    // It is passed to a memoized editor; a new identity every render would
    // re-render that editor on every keystroke elsewhere in the panel.
    const { result, rerender } = renderHook(() => useGenerateSubmitState());

    const first = result.current.onPromptChange;
    rerender();

    expect(result.current.onPromptChange).toBe(first);
  });

  it('marks the mount stale once it goes away', () => {
    // The panel body is keyed by node id, so closing and reopening on the same
    // node remounts a fresh instance — an in-flight submit from the old one
    // must not act on the new panel.
    const { result, unmount } = renderHook(() => useGenerateSubmitState());
    const { isMountedRef } = result.current;

    unmount();

    expect(isMountedRef.current).toBe(false);
  });
});
