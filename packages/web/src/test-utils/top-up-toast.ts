// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading what a refusal toast offered (inner#1968 D-22, D-23, D-26).
 *
 * A refusal because the month's operations are used up is said in a toast
 * whose action tops up: pressing it opens the credits overlay, the exclusive
 * overlay `CREDITS_OVERLAY_ID`. A spend-limit refusal offers no such action,
 * since topping up does not lift a limit. Suites mock `@web/lib/toast` with
 * `vi.fn()` methods and read the calls back through {@link toastsShown}.
 */

import { expect, type Mock } from 'vitest';

import { useUIStore } from '@web/stores/ui';

/** The exclusive overlay id the credits overlay opens under. */
export const CREDITS_OVERLAY_ID = 'credits-overlay';

/** One toast as a mocked toast method was called. */
export interface ShownToast {
  message: unknown;
  action: { label: unknown; onClick: (event: unknown) => void } | undefined;
}

/**
 * Every toast the given mocked methods were called with, in call order per method.
 * @param methods - The mocked toast methods (`toast.error`, `toast.warning`, ...).
 * @returns Each call's message and action.
 */
export function toastsShown(...methods: unknown[]): ShownToast[] {
  return methods.flatMap((method) =>
    (method as Mock).mock.calls.map((call: unknown[]) => ({
      message: call[0],
      action: (call[1] as { action?: ShownToast['action'] } | undefined)?.action,
    })),
  );
}

/**
 * Assert that exactly one toast was shown, carrying `fragment` and an action
 * labelled `label` whose press opens the credits overlay.
 * @param shown - The toasts shown.
 * @param fragment - Text the toast's sentence contains.
 * @param label - The action's label in the current locale.
 */
export function expectTopUpToast(shown: ShownToast[], fragment: string, label: string): void {
  expect(shown).toHaveLength(1);
  expect(String(shown[0]!.message)).toContain(fragment);
  expect(shown[0]!.action?.label).toBe(label);
  useUIStore.getState().setActiveOverlayId(null);
  shown[0]!.action?.onClick(new MouseEvent('click'));
  expect(useUIStore.getState().activeOverlayId).toBe(CREDITS_OVERLAY_ID);
}

/**
 * Assert that a refusal was said and no toast offered an action.
 * @param shown - The toasts shown.
 */
export function expectNoTopUpAction(shown: ShownToast[]): void {
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.map((toast) => toast.action)).toEqual(shown.map(() => undefined));
}
