// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * English counts one credit and one task in the singular (inner#1968): every
 * sentence the spend limits and the running-task limit added names an amount that can be exactly one, and "1 credits" or
 * "1 tasks" is wrong. Each case goes through the code that fills the sentence
 * in, so the value it passes is what the message selects on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatCredits, setLocale, t } from '@breatic/shared';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { spendCapMessage } from '@web/lib/spend-cap-message';
import { waitReason } from '@web/spaces/canvas/tasks/wait-reason';

const RESET = '2026-12-01T00:00:00.000Z';
const KEY = 'studio.container.credits.spendCap';

beforeEach(() => setLocale('en'));
afterEach(() => setLocale('en'));

describe('one of a thing in English', () => {
  const cases: [string, (n: string) => string, RegExp, RegExp][] = [
    ['a person\'s own spend limit refusal', (n) => spendCapMessage('member', n, RESET), /\(1 credit\)/, /\(2 credits\)/],
    ['the server\'s own spend limit refusal', (n) => t('server.spend_cap.member', { limit: formatCredits(n, 'en') }), /\(1 credit\)/, /\(2 credits\)/],
    ['a limit on the spend limits section', (n) => t(`${KEY}.amount`, { amount: formatCreditAmount(n) }), /^1 credit$/, /^2 credits$/],
    ['spent against a limit', (n) => t(`${KEY}.spentOfLimit`, { spent: formatCreditAmount('0.5'), limit: formatCreditAmount(n) }), /^0\.5 \/ 1 credit$/, /^0\.5 \/ 2 credits$/],
    ['the running-task limit', (n) => waitReason(t, Number(n), 'own'), /limit of 1 task running/, /limit of 2 tasks running/],
    ['someone else\'s running-task limit', (n) => waitReason(t, Number(n), 'other'), /limit of 1 task running/, /limit of 2 tasks running/],
    ['the counts column\'s running-task limit', (n) => waitReason(t, Number(n), { each: 2 }), /fewer than 1 task\./, /fewer than 2 tasks\./],
  ];

  it.each(cases)('%s says one in the singular and more in the plural', (_name, render, one, two) => {
    expect(render('1.000000')).toMatch(one);
    expect(render('2.000000')).toMatch(two);
  });

  it('keeps a part-credit amount plural', () => {
    expect(t(`${KEY}.amount`, { amount: formatCreditAmount('0.5') })).toBe('0.5 credits');
  });

  it('keeps the other locales unchanged', () => {
    setLocale('zh-CN');
    expect(t(`${KEY}.amount`, { amount: formatCreditAmount('1') })).toBe('1 积分');
    expect(t(`${KEY}.spentOfLimit`, { spent: '0.5', limit: '1' })).toBe('0.5 / 1 积分');
  });
});
