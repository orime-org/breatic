// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { apiGet, apiPost, runOnceRequest } from '@web/data/api/request';

/** A promoter code's status: disabled can be re-enabled, removed is final. */
export type ReferralCodeStatus = 'active' | 'disabled' | 'removed';

/** What the membership panel's two referral sections show (inner#1868 §8). */
export interface AccountReferral {
  /** The configured first-period discount; every percentage on screen uses it. */
  firstPeriodDiscountPercent: number;
  /** The code this account carries, and whether its first-period discount is still to come. */
  binding: { code: string; discountPending: boolean } | null;
  /** The account may still type a code in: carries none, never paid, not on an enterprise membership. */
  canBind: boolean;
  /** Promoter applications are open while a terms version is published. */
  program: { open: boolean; termsVersion: string };
  /** This account as a promoter. */
  promoter:
    | { state: 'none' }
    | { state: 'pending'; submittedAt: string }
    | { state: 'rejected'; decidedAt: string; note: string | null }
    | { state: 'approved'; code: string; link: string; codeStatus: ReferralCodeStatus };
}

/** The promoter application form. */
export interface PromoterApplicationForm {
  country: string;
  channels: string[];
  plan: string;
  termsVersion: string;
}

export const referralApi = {
  /**
   * Read the account's referral view.
   * @returns The view; the request answers 404 while payments are off.
   */
  get(): Promise<AccountReferral> {
    return apiGet<AccountReferral>('/account/referral');
  },

  /**
   * Bind a code before the first membership payment.
   * @param code - What the code field shows.
   * @param key - The press's `Idempotency-Key`; a re-send with it binds nothing twice.
   * @returns The fresh view.
   */
  bind(code: string, key: string): Promise<AccountReferral> {
    return apiPost<AccountReferral, { code: string }>('/account/referral/binding', { code }, runOnceRequest(key));
  },

  /**
   * Apply to become a promoter.
   * @param form - What the applicant filled in, with the terms version they agreed to.
   * @param key - The press's `Idempotency-Key`; a re-send with it files nothing twice.
   * @returns The fresh view.
   */
  apply(form: PromoterApplicationForm, key: string): Promise<AccountReferral> {
    return apiPost<AccountReferral, PromoterApplicationForm>('/account/referral/applications', form, runOnceRequest(key));
  },
};
