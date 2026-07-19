// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  getDoc,
  destroyDoc,
  onDocDestroyed,
  _resetForTests,
} from '@web/data/yjs/manager';
import {
  getCanvasUndoManager,
  _hasCanvasUndoManagerForTests,
} from '@web/data/yjs/canvas-space';

const NAME = 'project-pX/canvas-sX';

describe('doc destroy co-evicts the undo manager (#1786 — no relocated leak)', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('destroyDoc drops the canvas undo manager, not just the doc cache', () => {
    // Importing canvas-space registered the destroy listener at module load.
    const doc = getDoc(NAME);
    const manager = getCanvasUndoManager(doc, NAME);
    const destroySpy = vi.spyOn(manager, 'destroy');
    expect(_hasCanvasUndoManagerForTests(NAME)).toBe(true);

    destroyDoc(NAME);

    // The undo manager is destroyed AND dropped from its cache — without this it
    // would keep pinning the destroyed doc's content (the adversarial R1 leak).
    expect(destroySpy).toHaveBeenCalled();
    expect(_hasCanvasUndoManagerForTests(NAME)).toBe(false);
  });

  it('a meta doc (no undo manager) destroy is a safe no-op for the evictor', () => {
    const meta = getDoc('project-pX/meta');
    expect(meta).toBeTruthy();
    // No undo manager for a meta doc; the destroy listener must not throw.
    expect(() => destroyDoc('project-pX/meta')).not.toThrow();
  });

  it('onDocDestroyed fires the listener with the destroyed doc name', () => {
    const seen: string[] = [];
    onDocDestroyed((name) => seen.push(name));
    getDoc(NAME);
    destroyDoc(NAME);
    expect(seen).toContain(NAME);
    // Destroying an unknown name does not fire (nothing was cached).
    destroyDoc('project-pX/never-created');
    expect(seen).toEqual([NAME]);
  });
});
