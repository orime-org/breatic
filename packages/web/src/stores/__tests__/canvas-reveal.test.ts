// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasRevealStore } from '@web/stores/canvas-reveal';

beforeEach(() => { useCanvasRevealStore.setState({ request: null }); });

describe('the canvas reveal mailbox (#1411 design 5.4)', () => {
  it('holds the latest request until the named canvas takes it', () => {
    useCanvasRevealStore.getState().reveal('c1', 'n1');
    useCanvasRevealStore.getState().reveal('c1', 'n2');
    expect(useCanvasRevealStore.getState().request).toEqual({ spaceId: 'c1', nodeId: 'n2' });
    expect(useCanvasRevealStore.getState().take('c2')).toBeNull();
    expect(useCanvasRevealStore.getState().request).toEqual({ spaceId: 'c1', nodeId: 'n2' });
    expect(useCanvasRevealStore.getState().take('c1')).toBe('n2');
    expect(useCanvasRevealStore.getState().request).toBeNull();
    expect(useCanvasRevealStore.getState().take('c1')).toBeNull();
  });
});
