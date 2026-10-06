// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach } from 'vitest';

import { readUserPreferences, writeUserPreference } from '@web/lib/user-preferences-storage';
import { useCanvasStore } from '@web/stores/canvas';

const ALICE = 'user-alice';
const BOB = 'user-bob';

describe('useCanvasStore — minimap and snap remembered per account', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useCanvasStore.setState(useCanvasStore.getInitialState());
  });

  it('restores the defaults for an account that stored nothing', () => {
    useCanvasStore.setState({ minimapVisible: false, snapToGrid: true });
    useCanvasStore.getState().restoreViewPreferences(ALICE);
    expect(useCanvasStore.getState().minimapVisible).toBe(true);
    expect(useCanvasStore.getState().snapToGrid).toBe(false);
  });

  it('restores what each account stored', () => {
    writeUserPreference(ALICE, { minimapVisible: false, snapToGrid: true });

    useCanvasStore.getState().restoreViewPreferences(ALICE);
    expect(useCanvasStore.getState().minimapVisible).toBe(false);
    expect(useCanvasStore.getState().snapToGrid).toBe(true);

    useCanvasStore.getState().restoreViewPreferences(BOB);
    expect(useCanvasStore.getState().minimapVisible).toBe(true);
    expect(useCanvasStore.getState().snapToGrid).toBe(false);
  });

  it('writes every change to the restored account', () => {
    useCanvasStore.getState().restoreViewPreferences(ALICE);

    useCanvasStore.getState().toggleMinimap();
    useCanvasStore.getState().toggleSnapToGrid();
    expect(readUserPreferences(ALICE)).toMatchObject({ minimapVisible: false, snapToGrid: true });

    useCanvasStore.getState().setMinimapVisible(true);
    useCanvasStore.getState().setSnapToGrid(false);
    expect(readUserPreferences(ALICE)).toMatchObject({ minimapVisible: true, snapToGrid: false });
    expect(readUserPreferences(BOB)).toMatchObject({ minimapVisible: true, snapToGrid: false });
    expect(JSON.parse(window.localStorage.getItem('breatic.userPreferences') ?? '{}')).not.toHaveProperty(BOB);
  });

  it('writes nothing before an account is restored', () => {
    useCanvasStore.getState().toggleMinimap();
    expect(window.localStorage.length).toBe(0);
  });
});
