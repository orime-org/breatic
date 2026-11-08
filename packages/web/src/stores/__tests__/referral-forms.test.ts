// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useCurrentUserStore, type CurrentUser } from '@web/stores/current-user';
import {
  EMPTY_APPLICATION,
  clearReferralForm,
  editApplication,
  editBind,
  getReferralForms,
  isReferralFormOnScreen,
  resetReferralFormsForTests,
  useReferralFormOnScreen,
} from '@web/stores/referral-forms';

/**
 * Signs a user in.
 * @param id - The account id.
 */
function signIn(id: string): void {
  useCurrentUserStore.setState({ user: { id } as CurrentUser, role: null, loading: false, bootstrapped: true });
}

beforeEach(() => {
  signIn('u1');
});
afterEach(() => {
  resetReferralFormsForTests();
});

describe('the referral forms (inner#1868 tables 12.10, 12.12)', () => {
  it('keeps both drafts until they are cleared', () => {
    editBind({ value: 'XYZ', error: 'refused' });
    editApplication({ country: 'SG', plan: 'Tutorials', agreed: true });
    expect(getReferralForms().bind).toEqual({ value: 'XYZ', error: 'refused' });
    expect(getReferralForms().apply).toMatchObject({ country: 'SG', plan: 'Tutorials', agreed: true });

    clearReferralForm('bind');
    expect(getReferralForms().bind).toEqual({ value: null, error: null });
    expect(getReferralForms().apply.country).toBe('SG');
    clearReferralForm('apply');
    expect(getReferralForms().apply).toEqual(EMPTY_APPLICATION);
  });

  it('drops both drafts when another account signs in', () => {
    editBind({ value: 'XYZ', error: null });
    editApplication({ plan: 'Tutorials' });
    signIn('u2');
    expect(getReferralForms().bind).toEqual({ value: null, error: null });
    expect(getReferralForms().apply).toEqual(EMPTY_APPLICATION);
  });

  it('counts a form as on screen only while some component shows it', () => {
    expect(isReferralFormOnScreen('apply')).toBe(false);
    const shown = renderHook(({ on }) => useReferralFormOnScreen('apply', on), { initialProps: { on: false } });
    expect(isReferralFormOnScreen('apply')).toBe(false);
    shown.rerender({ on: true });
    expect(isReferralFormOnScreen('apply')).toBe(true);
    const second = renderHook(() => useReferralFormOnScreen('apply', true));
    shown.unmount();
    expect(isReferralFormOnScreen('apply')).toBe(true);
    second.unmount();
    expect(isReferralFormOnScreen('apply')).toBe(false);
    expect(isReferralFormOnScreen('bind')).toBe(false);
  });
});
