// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it, vi } from 'vitest';

import { createOrbitUserMoveWatch } from '@web/spaces/three-d/viewport/orbit-user-move';

describe('createOrbitUserMoveWatch', () => {
  it('reports the first camera change inside an orbit gesture, once', () => {
    const onUserMove = vi.fn();
    const watch = createOrbitUserMoveWatch(onUserMove);
    watch.start();
    watch.change();
    watch.change();
    expect(onUserMove).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for a press that never moves the camera', () => {
    const onUserMove = vi.fn();
    const watch = createOrbitUserMoveWatch(onUserMove);
    watch.start();
    expect(onUserMove).not.toHaveBeenCalled();
  });

  it('reports nothing for camera changes outside any gesture', () => {
    const onUserMove = vi.fn();
    const watch = createOrbitUserMoveWatch(onUserMove);
    watch.change();
    expect(onUserMove).not.toHaveBeenCalled();
  });

  it('reports a new gesture again', () => {
    const onUserMove = vi.fn();
    const watch = createOrbitUserMoveWatch(onUserMove);
    watch.start();
    watch.change();
    watch.start();
    watch.change();
    expect(onUserMove).toHaveBeenCalledTimes(2);
  });

  it('ignores the changes a follow applies, and disarms the gesture it interrupts', () => {
    const onUserMove = vi.fn();
    const watch = createOrbitUserMoveWatch(onUserMove);
    watch.start();
    watch.applying(() => watch.change());
    watch.change();
    expect(onUserMove).not.toHaveBeenCalled();
  });
});
