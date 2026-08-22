// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 一个时间戳变成给人看的那一天。
 *
 * 服务器一律以 UTC 记录，读的人分布在各个时区，所以这里唯一要钉的是「这一天
 * 是读者的那一天」，加上设计定死的形状。
 */

import { describe, it, expect, afterEach } from 'vitest';

import { formatLocalDay } from '@web/lib/format-day';

const REAL_TZ = process.env['TZ'];

/**
 * 换一个读者所在的时区。
 * @param tz - IANA 时区名。
 */
function readingFrom(tz: string): void {
  process.env['TZ'] = tz;
}

afterEach(() => {
  process.env['TZ'] = REAL_TZ;
});

describe('formatLocalDay', () => {
  it('给出读者本地的那一天，不是 UTC 的那一天', () => {
    // UTC 的午夜。东八区的读者这时是当天早上八点，纽约的读者还是前一天晚上。
    const midnightUtc = '2026-08-19T00:00:00.000Z';

    readingFrom('Asia/Shanghai');
    expect(formatLocalDay(midnightUtc)).toBe('2026-08-19');

    readingFrom('America/New_York');
    expect(formatLocalDay(midnightUtc)).toBe('2026-08-18');
  });

  it('跨月和跨年也跟着本地时区走', () => {
    readingFrom('America/New_York');
    expect(formatLocalDay('2026-01-01T00:00:00.000Z')).toBe('2025-12-31');

    readingFrom('Asia/Shanghai');
    expect(formatLocalDay('2026-03-01T00:00:00.000Z')).toBe('2026-03-01');
  });

  it('月和日补足两位，年月日之间是连字符', () => {
    readingFrom('UTC');
    expect(formatLocalDay('2026-08-04T12:00:00.000Z')).toBe('2026-08-04');
    expect(formatLocalDay('2026-12-31T12:00:00.000Z')).toBe('2026-12-31');
  });
});
