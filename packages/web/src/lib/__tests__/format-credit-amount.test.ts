// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 一个积分数变成给人看的字。
 *
 * 两件事要钉：小数位（同一个数在顶栏和积分页读出来必须一样），和用哪个
 * locale（语言开关设的那个，不是浏览器的）。
 */

import { describe, it, expect, vi } from 'vitest';

const locale = vi.hoisted(() => ({ current: 'en-US' }));

vi.mock('@breatic/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getLocale: () => locale.current };
});

const { formatCreditAmount } = await import('@web/lib/format-credit-amount');

describe('formatCreditAmount', () => {
  it('最多两位小数，跟积分页那一列一致', () => {
    // 模型的每次调用成本不是整数，所以带小数的余额是常态。
    expect(formatCreditAmount(10.368)).toBe('10.37');
    expect(formatCreditAmount(0.001)).toBe('0');
    expect(formatCreditAmount(-320.5)).toBe('-320.5');
  });

  it('分组符跟着语言开关走，不跟着浏览器', () => {
    locale.current = 'en-US';
    expect(formatCreditAmount(1234567)).toBe('1,234,567');

    locale.current = 'de-DE';
    expect(formatCreditAmount(1234567)).toBe('1.234.567');

    locale.current = 'en-US';
  });
});
