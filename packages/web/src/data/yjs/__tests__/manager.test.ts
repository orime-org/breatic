import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';

import { destroyDoc, docName, getDoc, _resetForTests } from '@web/data/yjs/manager';

describe('Yjs manager', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('getDoc returns the SAME Y.Doc instance for the same name', () => {
    const a = getDoc('project-1/meta');
    const b = getDoc('project-1/meta');
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(Y.Doc);
  });

  it('different names return different Y.Doc instances', () => {
    const a = getDoc('project-1/meta');
    const b = getDoc('project-2/meta');
    expect(a).not.toBe(b);
  });

  it('destroyDoc removes the cache entry; next getDoc creates a fresh instance', () => {
    const a = getDoc('project-1/meta');
    destroyDoc('project-1/meta');
    const b = getDoc('project-1/meta');
    expect(b).not.toBe(a);
  });

  it('destroyDoc on unknown name is a no-op (does not throw)', () => {
    expect(() => destroyDoc('does-not-exist')).not.toThrow();
  });

  it('docName.projectMeta follows the v10 multi-doc convention', () => {
    expect(docName.projectMeta('abc')).toBe('project-abc/meta');
  });

  it('docName.canvasSpace follows the v10 multi-doc convention', () => {
    expect(docName.canvasSpace('abc', 'def')).toBe('project-abc/canvas-def');
  });
});
