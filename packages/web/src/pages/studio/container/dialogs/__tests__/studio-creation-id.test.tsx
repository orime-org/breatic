// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Studio id a creation sends (inner#1955): the same while the form is
 * unchanged, a new one once it changes or after a renewal, and made without
 * `crypto.randomUUID`, which a page served over plain http on a LAN address
 * does not have.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStudioCreationId } from '@web/pages/studio/container/dialogs/studio-creation';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useStudioCreationId', () => {
  it('makes an id where crypto.randomUUID does not exist', () => {
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: undefined });
    const { result } = renderHook(() => useStudioCreationId('acme'));

    expect(result.current.idFor()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('keeps the id while the form is unchanged and takes a new one after a renewal', () => {
    const { result } = renderHook(() => useStudioCreationId('acme'));
    const first = result.current.idFor();

    expect(result.current.idFor()).toBe(first);
    result.current.renew();
    expect(result.current.idFor()).not.toBe(first);
  });
});
