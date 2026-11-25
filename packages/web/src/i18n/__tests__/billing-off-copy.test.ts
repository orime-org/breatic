// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The billing-off sentences (inner#1968, test spec E-07). A deployment that
 * does not charge credits is called self-hosted; the old "this deployment" wording is
 * gone from all five locales.
 */

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath, type LocaleTag } from '@web/test-utils/locale-catalogs';

/** What the two billing-off strings said before they named self-hosting. */
const OLD_WORDING: Record<LocaleTag, readonly [string, string]> = {
  en: ['This deployment does not charge credits', 'This deployment does not charge credits. Below is what was used.'],
  'zh-CN': ['这个部署不计积分', '这个部署不计积分，下面是用量记录。'],
  'zh-TW': ['這個部署不計點數', '這個部署不計點數，以下是用量紀錄。'],
  ja: ['この環境ではクレジットを消費しません', 'この環境ではクレジットを消費しません。以下は使用量の記録です。'],
  ko: ['이 배포에서는 크레딧을 차감하지 않습니다', '이 배포에서는 크레딧을 차감하지 않습니다. 아래는 사용량 기록입니다.'],
};

/**
 * The zh-CN catalog.
 * @returns It.
 */
function zhCN(): unknown {
  return LOCALE_CATALOGS.find(([tag]) => tag === 'zh-CN')![1];
}

describe('E-07 a deployment that does not charge credits is self-hosted', () => {
  it('reads in zh-CN as 自部署', () => {
    expect(readPath(zhCN(), 'credits.billingOff.title')).toBe('自部署不计积分');
    expect(readPath(zhCN(), 'credits.ledgerBillingOff')).toBe('自部署不计积分，下面是用量记录。');
  });

  it('says self-hosted in English', () => {
    const en = LOCALE_CATALOGS.find(([tag]) => tag === 'en')![1];
    expect(readPath(en, 'credits.billingOff.title')).toMatch(/self-hosted/i);
    expect(readPath(en, 'credits.ledgerBillingOff')).toMatch(/self-hosted/i);
  });

  it.each(LOCALE_CATALOGS)('%s no longer says "this deployment"', (tag, catalog) => {
    const [title, ledger] = OLD_WORDING[tag];
    expect(readPath(catalog, 'credits.billingOff.title')).not.toBe(title);
    expect(readPath(catalog, 'credits.ledgerBillingOff')).not.toBe(ledger);
  });
});
