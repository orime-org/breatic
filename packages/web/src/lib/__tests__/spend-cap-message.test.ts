// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The sentence a spend-cap refusal is told in (inner#1968, test spec H-31,
 * H-32; 5.1 resolution #10).
 *
 * `spendCapMessage(reason, scope, limit, resetsAt)` builds it from the 402's
 * fields: the member scope names the limit through `formatCredits`, the studio
 * scope does not; the reset date is `new Date(resetsAt)` shown in the user's
 * local time with `getLocale()`. Neither offers a top-up. The module path
 * `@web/lib/spend-cap-message` is this suite's choice; the design names only
 * the function.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@breatic/shared';
import { ApiException } from '@web/data/api/types';
import { spendCapMessage } from '@web/lib/spend-cap-message';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';

let zone: string | undefined;

beforeEach(() => {
  zone = process.env.TZ;
  setLocale('zh-CN');
});

afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
  setLocale('en');
});

describe('spendCapMessage', () => {
  it('H-31 says the member cap with its limit and the reset day, and offers no top-up', () => {
    process.env.TZ = 'UTC';
    const said = spendCapMessage('spend_cap_reached', 'member', '10', '2026-12-01T00:00:00.000Z');
    expect(said).toBe('你本月在这个 Studio 的花费已到上限（10 积分），2026年12月1日 重置。需要更多请联系 Studio Admin');
    expect(said).not.toContain('充值');
  });

  it('H-32 says the studio cap with the reset day in the local time zone', () => {
    process.env.TZ = 'America/New_York';
    const said = spendCapMessage('spend_cap_reached', 'studio', '100', '2026-12-01T00:00:00.000Z');
    expect(said).toBe('这个 Studio 本月的花费已到上限，2026年11月30日 重置。请联系 Studio Admin');
    expect(said).not.toContain('充值');
  });

  it('5.1 #10 writes the limit as formatCredits does: up to the cent, no trailing zeros', () => {
    process.env.TZ = 'UTC';
    expect(spendCapMessage('spend_cap_reached', 'member', '10.500000', '2026-12-01T00:00:00.000Z')).toContain('（10.5 积分）');
  });
});

// H-33: a generation refused by a spend cap says the cap sentence before any
// credits sentence.
describe('executeErrorMessage for a spend cap', () => {
  it('says what spendCapMessage says for the refusal', async () => {
    process.env.TZ = 'UTC';
    const resetsAt = '2026-12-01T00:00:00.000Z';
    const capped = new ApiException({
      status: 402,
      message: 'capped',
      reason: 'spend_cap_reached',
      fromServer: true,
      details: { reason: 'spend_cap_reached', scope: 'member', limit: '10', resetsAt },
    });
    expect(await executeErrorMessage(capped, (key: string) => key)).toBe(spendCapMessage('spend_cap_reached', 'member', '10', resetsAt));
  });
});
