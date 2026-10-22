// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * useWaitForSlugCheck (inner#1652): a press that lands while the studio slug
 * is still being checked waits for the answer and then tries again, unless the
 * slug changed or the form went away in the meantime.
 */

import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useWaitForSlugCheck } from '@web/pages/studio/container/dialogs/use-wait-for-slug-check';
import type { SlugCheck } from '@web/pages/studio/container/dialogs/slug-util';

interface Props {
  check: SlugCheck;
  slug: string;
  active: boolean;
  onSettled: () => void;
}

/**
 * Render the hook with props that the test can change.
 * @param initial - The first props.
 * @returns The hook result and its rerender.
 */
function setup(initial: Partial<Props> = {}): {
  result: { current: ReturnType<typeof useWaitForSlugCheck> };
  rerender: (next: Partial<Props>) => void;
  onSettled: ReturnType<typeof vi.fn>;
} {
  const onSettled = vi.fn();
  let props: Props = { check: { state: 'checking' }, slug: 'nova-lab', active: true, onSettled, ...initial };
  const hook = renderHook((p: Props) => useWaitForSlugCheck(p.check, p.slug, p.active, p.onSettled), {
    initialProps: props,
  });
  return {
    result: hook.result,
    rerender: (next) => {
      props = { ...props, ...next };
      hook.rerender(props);
    },
    onSettled,
  };
}

describe('useWaitForSlugCheck', () => {
  it('waits while the check runs and tries again once it settles', () => {
    const { result, rerender, onSettled } = setup();
    act(() => result.current.start());
    expect(result.current.waiting).toBe(true);
    expect(onSettled).not.toHaveBeenCalled();

    rerender({ check: { state: 'valid' } });
    expect(result.current.waiting).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);

    // Settling once is one more try, not one per render.
    rerender({ check: { state: 'valid' } });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('tries again with the latest submit, which reads the current values', () => {
    const { result, rerender, onSettled } = setup();
    act(() => result.current.start());
    const latest = vi.fn();
    rerender({ onSettled: latest });
    rerender({ check: { state: 'invalid', reason: 'taken' } });
    expect(onSettled).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('drops the wait when the slug changes', () => {
    const { result, rerender, onSettled } = setup();
    act(() => result.current.start());
    rerender({ slug: 'nova-labs' });
    expect(result.current.waiting).toBe(false);
    rerender({ check: { state: 'valid' } });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('drops the wait when the form closes', () => {
    const { result, rerender, onSettled } = setup();
    act(() => result.current.start());
    rerender({ active: false });
    expect(result.current.waiting).toBe(false);
    rerender({ active: true, check: { state: 'valid' } });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('compares the slug as it will be sent, ignoring surrounding spaces', () => {
    const { result, rerender, onSettled } = setup();
    act(() => result.current.start());
    rerender({ slug: ' nova-lab ' });
    expect(result.current.waiting).toBe(true);
    rerender({ check: { state: 'unverified' } });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
