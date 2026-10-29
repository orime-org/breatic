// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';
import { _resetForTests, destroyDoc, getDoc } from '../manager';

afterEach(() => _resetForTests());

describe('shared scene document lifetime', () => {
  it('reuses the canonical document across consumers and Activity mounts', () => {
    const doc = getDoc('project-p/3d-s');
    doc.getMap('scene').set('formatVersion', 1);
    expect(getDoc('project-p/3d-s')).toBe(doc);
    expect(getDoc('project-p/3d-s').getMap('scene').get('formatVersion')).toBe(1);
  });

  it('destroys the document when the owning provider releases it', () => {
    const doc = getDoc('project-p/3d-s');
    destroyDoc('project-p/3d-s', doc);
    expect(doc.isDestroyed).toBe(true);
    expect(getDoc('project-p/3d-s')).not.toBe(doc);
  });

  it('starts with a new empty document after a closed scene is reopened', () => {
    const doc = getDoc('project-p/3d-s');
    doc.getMap('objects').set('previous-content', true);
    destroyDoc('project-p/3d-s', doc);
    const reopened = getDoc('project-p/3d-s');
    expect(reopened).not.toBe(doc);
    expect(reopened.getMap('objects').size).toBe(0);
  });

  it('ignores the old provider instance when the canonical name has reopened', () => {
    const oldDoc = getDoc('project-p/3d-s');
    destroyDoc('project-p/3d-s', oldDoc);
    const current = getDoc('project-p/3d-s');
    destroyDoc('project-p/3d-s', oldDoc);
    expect(oldDoc.isDestroyed).toBe(true);
    expect(current.isDestroyed).toBe(false);
    expect(getDoc('project-p/3d-s')).toBe(current);
  });
});
