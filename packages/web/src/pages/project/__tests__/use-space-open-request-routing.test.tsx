// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Project page carries out Space-open requests (#1490 design §13.5). A request still being made when the page
 * closes must not outlive the page: the store would hold it in creating and every later request would wait behind it.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSpaceOpenRequestRouting } from '@web/pages/project/use-space-open-request-routing';
import { useSpaceOpenRequestStore } from '@web/stores/space-open-request';

afterEach(() => { useSpaceOpenRequestStore.setState({ state: { status: 'none' } }); });

describe('closing the Project page', () => {
  it('ends a request still making its Space, so the next request is taken', () => {
    const create = vi.fn(() => new Promise<void>(() => {}));
    const hook = renderHook(() => useSpaceOpenRequestRouting([], null, true, vi.fn(), create));
    useSpaceOpenRequestStore.getState().dispatch({ type: 'request', request: { type: 'web_animation' } });
    hook.rerender();
    expect(useSpaceOpenRequestStore.getState().state.status).toBe('creating');
    hook.unmount();
    expect(useSpaceOpenRequestStore.getState().state).toEqual({ status: 'none' });
    useSpaceOpenRequestStore.getState().dispatch({ type: 'request', request: { type: 'web_animation' } });
    expect(useSpaceOpenRequestStore.getState().state.status).toBe('requesting');
  });
});
