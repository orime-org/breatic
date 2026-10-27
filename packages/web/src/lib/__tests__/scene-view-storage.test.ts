// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { readSceneView, writeSceneView } from '@web/lib/scene-view-storage';
import { STORAGE_KEYS } from '@web/lib/storage-keys';

const VIEW = { position: [4, 3, 6], target: [0, 1, 0] } as const;

describe('personal scene views', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps accounts, projects and Spaces independent without changing tab storage', () => {
    window.localStorage.setItem(STORAGE_KEYS.projectTabs, 'untouched');
    expect(writeSceneView('alice', 'project', 'space', VIEW)).toBe(true);
    expect(readSceneView('alice', 'project', 'space')).toEqual(VIEW);
    expect(readSceneView('bob', 'project', 'space')).toBeNull();
    expect(readSceneView('alice', 'other', 'space')).toBeNull();
    expect(readSceneView('alice', 'project', 'other')).toBeNull();
    const other = { position: [1, 2, 3], target: [0, 0, 0] } as const;
    expect(writeSceneView('bob', 'project', 'space', other)).toBe(true);
    expect(writeSceneView('alice', 'other', 'space', other)).toBe(true);
    expect(writeSceneView('alice', 'project', 'other', other)).toBe(true);
    expect(readSceneView('alice', 'project', 'space')).toEqual(VIEW);
    expect(window.localStorage.getItem(STORAGE_KEYS.projectTabs)).toBe('untouched');
  });

  it('round trips finite non-coincident views', () => {
    const point = fc.tuple(fc.integer(), fc.integer(), fc.integer());
    fc.assert(fc.property(point, point, (position, target) => {
      fc.pre(position.some((value, index) => value !== target[index]));
      expect(writeSceneView('alice', 'project', 'space', { position, target })).toBe(true);
      expect(readSceneView('alice', 'project', 'space')).toEqual({ position, target });
    }));
  });

  it('rejects missing identities and invalid camera geometry', () => {
    expect(writeSceneView(undefined, 'project', 'space', VIEW)).toBe(false);
    expect(writeSceneView('', 'project', 'space', VIEW)).toBe(false);
    expect(writeSceneView('alice', '', 'space', VIEW)).toBe(false);
    expect(writeSceneView('alice', 'project', '', VIEW)).toBe(false);
    expect(writeSceneView('alice', 'project', 'space', {
      position: [0, 0, 0], target: [0, 0, 0],
    })).toBe(false);
    expect(writeSceneView('alice', 'project', 'space', {
      position: [Infinity, 0, 0], target: [0, 0, 0],
    })).toBe(false);
    expect(readSceneView('alice', 'project', 'space')).toBeNull();
  });

  it('discards only the malformed view when reading', () => {
    window.localStorage.setItem(STORAGE_KEYS.sceneViews, JSON.stringify({ alice: {
      project: { broken: { position: [0, 1], target: [0, 0, 0] }, valid: VIEW },
    } }));
    expect(readSceneView('alice', 'project', 'broken')).toBeNull();
    expect(readSceneView('alice', 'project', 'valid')).toEqual(VIEW);
  });

  it('reports write failure even when the requested view was already stored', () => {
    expect(writeSceneView('alice', 'project', 'space', VIEW)).toBe(true);
    const previous = window.localStorage.getItem(STORAGE_KEYS.sceneViews);
    vi.stubGlobal('localStorage', {
      clear: vi.fn(),
      getItem: (): string | null => previous,
      setItem: (): never => { throw new DOMException('Full', 'QuotaExceededError'); },
    });
    expect(readSceneView('alice', 'project', 'space')).toEqual(VIEW);
    expect(writeSceneView('alice', 'project', 'space', VIEW)).toBe(false);
  });
});
