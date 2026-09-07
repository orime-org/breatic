// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { isEditableTarget } from '@web/lib/is-editable-target';

describe('isEditableTarget', () => {
  it('is false for null', () => {
    expect(isEditableTarget(null)).toBe(false);
  });

  it('is true for an input', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
  });

  it('is true for a textarea', () => {
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
  });

  it('is true for a contenteditable element', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'isContentEditable', { value: true });
    expect(isEditableTarget(el)).toBe(true);
  });

  it('is false for a button', () => {
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
  });

  it('is false for a plain div', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
  });

  // A <select> takes keys but holds no caret, so the canvas keeps its own
  // shortcuts over it — the behaviour the canvas gate had before this moved
  // out of CanvasSpace.
  it('is false for a select', () => {
    expect(isEditableTarget(document.createElement('select'))).toBe(false);
  });
});
