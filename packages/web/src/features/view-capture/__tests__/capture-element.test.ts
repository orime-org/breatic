// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';

import { backgroundBehind } from '@web/features/view-capture/capture-element';

afterEach(() => {
  document.body.innerHTML = '';
  document.body.style.backgroundColor = '';
});

describe('backgroundBehind', () => {
  it('takes the first painted background up the tree', () => {
    const outer = document.createElement('div');
    outer.style.backgroundColor = 'rgb(30, 30, 30)';
    const inner = document.createElement('div');
    outer.append(inner);
    document.body.append(outer);
    expect(backgroundBehind(inner)).toBe('rgb(30, 30, 30)');
  });

  it('answers nothing when nothing up the tree is painted', () => {
    const el = document.createElement('div');
    document.body.append(el);
    expect(backgroundBehind(el)).toBeUndefined();
  });
});
