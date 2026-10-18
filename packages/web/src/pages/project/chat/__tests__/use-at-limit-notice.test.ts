// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The word about a full box is a thing that happened (inner#1530): a toast,
 * said when the text reaches the limit and again for every keystroke the box
 * turns away after that.
 */
import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';

const toastSpy = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: { warning: toastSpy.warning, error: vi.fn() } }));

const { useAtLimitNotice } = await import('@web/pages/project/chat/use-at-limit-notice');

const LIMIT = 10;
/**
 * The line, in the language loaded when a case runs.
 * @returns It.
 */
const line = (): string => t('chat.composer.atLimit', { limit: LIMIT });

beforeEach(() => {
  toastSpy.warning.mockClear();
});

describe('the word about a full box', () => {
  it('says nothing while there is still room', () => {
    renderHook(({ length }) => useAtLimitNotice(length, LIMIT), { initialProps: { length: LIMIT - 1 } });
    expect(toastSpy.warning).not.toHaveBeenCalled();
  });

  it('says it the moment the text reaches the limit, once', () => {
    const { rerender } = renderHook(({ length }) => useAtLimitNotice(length, LIMIT), {
      initialProps: { length: LIMIT - 1 },
    });
    rerender({ length: LIMIT });
    rerender({ length: LIMIT });
    expect(toastSpy.warning.mock.calls).toEqual([[line()]]);
  });

  it('says it again for a keystroke the box refused', () => {
    const { result, rerender } = renderHook(({ length }) => useAtLimitNotice(length, LIMIT), {
      initialProps: { length: LIMIT - 1 },
    });
    rerender({ length: LIMIT });
    act(() => result.current.sayAgain());
    expect(toastSpy.warning).toHaveBeenCalledTimes(2);
  });

  it('says nothing about a draft that was already full when it opened', () => {
    renderHook(({ length }) => useAtLimitNotice(length, LIMIT), { initialProps: { length: LIMIT } });
    expect(toastSpy.warning).not.toHaveBeenCalled();
  });

  it('says it again when the text comes back to the limit', () => {
    const { rerender } = renderHook(({ length }) => useAtLimitNotice(length, LIMIT), {
      initialProps: { length: LIMIT - 1 },
    });
    rerender({ length: LIMIT });
    rerender({ length: LIMIT - 1 });
    rerender({ length: LIMIT });
    expect(toastSpy.warning).toHaveBeenCalledTimes(2);
  });
});
