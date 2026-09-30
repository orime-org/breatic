// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Rendering a byte count for a reader.
 *
 * The membership ceilings are configured in bytes (base is 5368709120) and
 * nobody reads that, and every value in that file was written as a whole
 * number of GiB or TiB — so showing one means putting it back into the unit
 * somebody wrote it in. The canvas shows a file's size against the understand
 * ceiling the same way.
 */

import { describe, it, expect } from 'vitest';

import { formatBytes } from '@web/lib/format-bytes';

describe('formatBytes', () => {
  it('把配置里的字节还原成写它时用的单位', () => {
    // 这四个值就是 config/membership.yaml 里四档的 storage_bytes。
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GiB');
    expect(formatBytes(200 * 1024 ** 3)).toBe('200 GiB');
    expect(formatBytes(500 * 1024 ** 3)).toBe('500 GiB');
    expect(formatBytes(100 * 1024 ** 4)).toBe('100 TiB');
  });

  it('用量不是整数时保留一位小数', () => {
    // 用量是真实累加出来的，不会正好落在整数上。
    expect(formatBytes(38.4 * 1024 ** 3)).toBe('38.4 GiB');
    expect(formatBytes(1536 * 1024 ** 2)).toBe('1.5 GiB');
  });

  it('小于一个单位时降一级，不显示 0.0', () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MiB');
    expect(formatBytes(4096)).toBe('4 KiB');
  });

  it('零字节显示成 0 B，不是空的也不是 0 GiB', () => {
    // 一个刚建号、什么都没传过的账号会看到这个数。
    expect(formatBytes(0)).toBe('0 B');
  });
});

describe('formatBytes 的单位边界', () => {
  it('舍入到 1024 时进位到下一个单位，不写出 1024 KiB 这种单位', () => {
    // 函数承诺的是「让数值大于一的最大那个单位」。1048575 字节按 KiB 算是
    // 1023.999，四舍五入成 1024 —— 那个数在这个单位上不存在，它就是 1 MiB。
    expect(formatBytes(1024 ** 2 - 1)).toBe('1 MiB');
    expect(formatBytes(1024 ** 3 - 1)).toBe('1 GiB');
    expect(formatBytes(1024 ** 4 - 1)).toBe('1 TiB');
  });

  it('进位之后仍然停在最大的那个单位上', () => {
    // PiB 是这套单位的顶，再大也不该往上找。
    expect(formatBytes(1024 ** 5 * 2048)).toBe('2048 PiB');
  });

  it('没到进位线的值照旧', () => {
    expect(formatBytes(1023 * 1024)).toBe('1023 KiB');
    expect(formatBytes(1024 ** 3)).toBe('1 GiB');
  });
});
