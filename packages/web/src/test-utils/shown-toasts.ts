// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading back what a mocked toast showed. Suites mock `@web/lib/toast` with
 * `vi.fn()` methods and read the calls back through {@link toastsShown}.
 */

import type { Mock } from 'vitest';

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
