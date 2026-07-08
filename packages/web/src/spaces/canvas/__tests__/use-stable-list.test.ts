// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useStableList } from '@web/spaces/canvas/use-stable-list';

/**
 * `useStableList` keeps a derived list's REFERENCE stable across renders when
 * its content is unchanged, so downstream memos / subscribers bail (#1647 step
 * 4). The Yjs mirror hands a fresh `flowNodes` array on every doc change, so a
 * derived `filter().map()` produces a new array each time even when the result
 * is identical — this collapses those to the previous reference.
 */
describe('useStableList', () => {
  it('returns the same reference when content is unchanged', () => {
    const { result, rerender } = renderHook(({ list }) => useStableList(list), {
      initialProps: { list: ['a', 'b'] },
    });
    const first = result.current;
    // A fresh array with identical content (what a re-derived filter().map() yields).
    rerender({ list: ['a', 'b'] });
    expect(result.current).toBe(first); // SAME reference → downstream bails
  });

  it('returns the new reference when content changes', () => {
    const { result, rerender } = renderHook(({ list }) => useStableList(list), {
      initialProps: { list: ['a', 'b'] },
    });
    const first = result.current;
    rerender({ list: ['a', 'b', 'c'] });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual(['a', 'b', 'c']);
  });

  it('detects order changes (same members, different order)', () => {
    const { result, rerender } = renderHook(({ list }) => useStableList(list), {
      initialProps: { list: ['a', 'b'] },
    });
    const first = result.current;
    rerender({ list: ['b', 'a'] });
    expect(result.current).not.toBe(first);
  });

  it('detects a single-element change at the same length', () => {
    const { result, rerender } = renderHook(({ list }) => useStableList(list), {
      initialProps: { list: ['a', 'b'] },
    });
    const first = result.current;
    rerender({ list: ['a', 'c'] });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual(['a', 'c']);
  });

  it('compares objects with a custom key selector', () => {
    const { result, rerender } = renderHook(
      ({ list }) => useStableList(list, (item) => item.id),
      { initialProps: { list: [{ id: 'a' }, { id: 'b' }] } },
    );
    const first = result.current;
    // Fresh objects, identical ids → stable reference.
    rerender({ list: [{ id: 'a' }, { id: 'b' }] });
    expect(result.current).toBe(first);
    // Different id → new reference.
    rerender({ list: [{ id: 'a' }, { id: 'z' }] });
    expect(result.current).not.toBe(first);
  });
});
