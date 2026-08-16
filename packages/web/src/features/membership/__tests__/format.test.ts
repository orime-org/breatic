// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 会员面板里数字怎么显示（任务 #90）。
 *
 * 存储上限在配置里是字节（base 是 5368709120），照原样显示没人读得懂，
 * 而配置里的每个值本来就是按 GiB / TiB 整数写的，所以显示要还原成写它的
 * 那个单位。
 */

import { describe, it, expect } from 'vitest';

import { formatBytes, usageRatio } from '@web/features/membership/format';

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

describe('usageRatio', () => {
  it('给出进度条要画多满', () => {
    expect(usageRatio(1, 4)).toBe(0.25);
    expect(usageRatio(0, 4)).toBe(0);
  });

  it('超限时封在满格，进度条画不出超过 100% 的宽度', () => {
    // 超限本身照实报数字（那句文案说的就是它），但条子只能画到头。
    expect(usageRatio(9, 4)).toBe(1);
  });

  it('上限是零时，用了就是满格、没用就是空的', () => {
    // base 的 team_studios 就是 0，而零是真值零、不是「无限制」的哨兵，
    // 所以这里不能除出一个 NaN 交给样式。
    expect(usageRatio(0, 0)).toBe(0);
    expect(usageRatio(1, 0)).toBe(1);
  });
});
