// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the referral backfill field and the promoter application dialog hold
 * (inner#1868 tables 12.10, 12.12).
 *
 * Kept here, outside the components, because a press on either form runs in
 * `runOnce` and outlives the membership panel that draws it: closing the panel
 * unmounts the form while the press still waits, and the answer has to land
 * where the next form on screen reads it. Kept per account, like the presses.
 */

import * as React from 'react';
import { create } from 'zustand';

import { useCurrentUserStore } from '@web/stores/current-user';

/** The backfill field. */
export interface BindDraft {
  /** What the field holds; null until typed or sent, when the field shows the carried code. */
  value: string | null;
  /** The refusal shown under the field. */
  error: string | null;
}

/** The application dialog. */
export interface ApplicationDraft {
  country: string;
  channels: string[];
  plan: string;
  /** The terms version on screen when the box was ticked; null while unticked. It is what the press agrees to. */
  agreedTerms: string | null;
  /** The terms changed under the last press; shown until the box is ticked again. */
  termsNotice: boolean;
}

/** Which form. */
export type ReferralForm = 'bind' | 'apply';

interface ReferralFormsState {
  bind: BindDraft;
  apply: ApplicationDraft;
}

const EMPTY_BIND: Readonly<BindDraft> = Object.freeze({ value: null, error: null });

/** The application dialog before anything is filled in. */
export const EMPTY_APPLICATION: Readonly<ApplicationDraft> = Object.freeze({
  country: '',
  channels: [''],
  plan: '',
  agreedTerms: null,
  termsNotice: false,
});

const useReferralFormsStore = create<ReferralFormsState>(() => ({ bind: EMPTY_BIND, apply: EMPTY_APPLICATION }));

/**
 * Read both forms.
 * @returns Both drafts as they stand.
 */
export function getReferralForms(): ReferralFormsState {
  return useReferralFormsStore.getState();
}

/**
 * Subscribe to one form.
 * @param form - Which form.
 * @returns That form's draft.
 */
export function useReferralForm<F extends ReferralForm>(form: F): ReferralFormsState[F] {
  return useReferralFormsStore((s) => s[form]);
}

/**
 * Change the backfill field.
 * @param patch - The fields that change.
 */
export function editBind(patch: Partial<BindDraft>): void {
  useReferralFormsStore.setState((s) => ({ bind: { ...s.bind, ...patch } }));
}

/**
 * Change the application dialog.
 * @param patch - The fields that change.
 */
export function editApplication(patch: Partial<ApplicationDraft>): void {
  useReferralFormsStore.setState((s) => ({ apply: { ...s.apply, ...patch } }));
}

/**
 * Empty one form.
 * @param form - Which form.
 */
export function clearReferralForm(form: ReferralForm): void {
  useReferralFormsStore.setState(form === 'bind' ? { bind: EMPTY_BIND } : { apply: EMPTY_APPLICATION });
}

// How many components show each form now; an answer nobody can see goes to a toast.
const onScreen: Record<ReferralForm, number> = { bind: 0, apply: 0 };

/**
 * Count this component as showing a form while `shown` is true.
 * @param form - Which form.
 * @param shown - Whether the form is on screen (the field is mounted, the dialog is open).
 */
export function useReferralFormOnScreen(form: ReferralForm, shown: boolean): void {
  React.useEffect(() => {
    if (!shown) return undefined;
    onScreen[form] += 1;
    return () => {
      onScreen[form] -= 1;
    };
  }, [form, shown]);
}

/**
 * Whether some component shows a form now.
 * @param form - Which form.
 * @returns True while at least one does.
 */
export function isReferralFormOnScreen(form: ReferralForm): boolean {
  return onScreen[form] > 0;
}

/**
 * Empty both forms between test cases.
 */
export function resetReferralFormsForTests(): void {
  clearReferralForm('bind');
  clearReferralForm('apply');
}

// A draft typed into one account is not the next account's.
useCurrentUserStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) {
    clearReferralForm('bind');
    clearReferralForm('apply');
  }
});
