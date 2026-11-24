// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Motion play bar's clock is handed to callbacks and effects of the Space (#1490 design §7.1), so it keeps one
 * identity until its time, its playing flag or its result changes.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useMotionClock } from '@web/spaces/web-animation/use-motion-clock';

describe('useMotionClock', () => {
  it('returns the same clock on a render that changed nothing', () => {
    const { result, rerender } = renderHook(({ seconds, key }) => useMotionClock(seconds, key), { initialProps: { seconds: 4, key: 'a' } });
    const first = result.current;
    rerender({ seconds: 4, key: 'a' });
    expect(result.current).toBe(first);
  });

  it('returns a new clock once its time changes', () => {
    const { result } = renderHook(() => useMotionClock(4, 'a'));
    const first = result.current;
    act(() => result.current.seek(2));
    expect(result.current).not.toBe(first);
    expect(result.current.time).toBe(2);
  });
});
