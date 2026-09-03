// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Both directions of the content-keyed identity, which is the whole point of
 * the hook: keeping the identity while nothing changed is what makes a
 * `React.memo` child bail, and releasing it the moment the content changes is
 * what keeps that child from showing stale data.
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useContentStable } from '@web/spaces/canvas/generate/use-content-stable';

describe('useContentStable', () => {
  it('keeps the identity when a new object carries the same content', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: { a: number } }) => useContentStable(value),
      { initialProps: { value: { a: 1 } } },
    );
    const first = result.current;
    rerender({ value: { a: 1 } });
    expect(result.current).toBe(first);
  });

  it('releases it the moment the content differs', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: { a: number } }) => useContentStable(value),
      { initialProps: { value: { a: 1 } } },
    );
    const first = result.current;
    rerender({ value: { a: 2 } });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual({ a: 2 });
  });

  it('sees a change deep inside an array of rows', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: Array<{ id: string; text: string }> }) =>
        useContentStable(value),
      { initialProps: { value: [{ id: 'a', text: 'one' }] } },
    );
    const first = result.current;
    rerender({ value: [{ id: 'a', text: 'two' }] });
    expect(result.current).not.toBe(first);
  });

  it('sees a row appended to an otherwise unchanged list', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string[] }) => useContentStable(value),
      { initialProps: { value: ['a'] } },
    );
    const first = result.current;
    rerender({ value: ['a', 'b'] });
    expect(result.current).not.toBe(first);
  });
});
