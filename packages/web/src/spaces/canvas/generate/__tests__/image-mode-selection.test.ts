// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  IMAGE_MODE_OPTIONS,
  resolveMode,
} from '@web/spaces/canvas/generate/image-mode-selection';

/** 两档都可用的部署 —— 除非某条用例专门要收窄它。 */
const BOTH = IMAGE_MODE_OPTIONS;
const ONLY_I2I = IMAGE_MODE_OPTIONS.filter((o) => o.value === 'i2i');

describe('IMAGE_MODE_OPTIONS', () => {
  it('就是面板提供的那两档，顺序是 t2i 在前', () => {
    expect(IMAGE_MODE_OPTIONS.map((o) => o.value)).toEqual(['t2i', 'i2i']);
  });

  it('每档都带 label 和 testId（选择器直接拿它渲染）', () => {
    for (const option of IMAGE_MODE_OPTIONS) {
      expect(option.label.length, `${option.value} 的 label`).toBeGreaterThan(0);
      expect(option.testId.length, `${option.value} 的 testId`).toBeGreaterThan(0);
    }
  });
});

describe('resolveMode（#1951 判据是可用，不是合法）', () => {
  it('存的档可用，就用它', () => {
    expect(resolveMode('i2i', BOTH)).toBe('i2i');
    expect(resolveMode('t2i', BOTH)).toBe('t2i');
  });

  it('没存过，取可用档第一个', () => {
    expect(resolveMode(undefined, BOTH)).toBe('t2i');
    expect(resolveMode('', BOTH)).toBe('t2i');
  });

  it('Yjs 里是个不认识的值，取可用档第一个', () => {
    expect(resolveMode('bogus', BOTH)).toBe('t2i');
  });

  it('存的是 t2i 但这个部署没有 t2i 的模型，落到 i2i', () => {
    // 这一条是本次要改的行为：以前 t2i 合法就放行，节点停在一个
    // 选择器里根本没有的档上。
    expect(resolveMode('t2i', ONLY_I2I)).toBe('i2i');
  });

  it('没存过且只有 i2i 可用，落到 i2i 而不是写死的 t2i', () => {
    expect(resolveMode(undefined, ONLY_I2I)).toBe('i2i');
  });
});
