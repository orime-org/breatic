// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 会员面板里数字怎么显示（任务 #90）。
 *
 * 存储上限在配置里是字节（base 是 5368709120），照原样显示没人读得懂，
 * 而配置里的每个值本来就是按 GiB / TiB 整数写的，所以显示要还原成写它的
 * 那个单位。
 */

import { describe, it, expect } from 'vitest';

import { usageRatio } from '@web/features/membership/format';

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
