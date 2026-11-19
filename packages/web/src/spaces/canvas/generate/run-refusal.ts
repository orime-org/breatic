// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shows the words a Generate press was refused with (`run-plan.ts` in shared
 * decides them; the panel only says them).
 */

import type { RunRefusalText } from '@breatic/shared/canvas-model';

import { toast } from '@web/lib/toast';

/**
 * Warn with a run's refusal; a refusal that says nothing shows nothing.
 * @param text - What the refusal says.
 * @param t - The panel's translator.
 */
export function showRunRefusal(
  text: RunRefusalText | null,
  t: (key: string, values?: Record<string, string | number>) => string,
): void {
  if (text === null) return;
  if ('message' in text) {
    toast.warning(text.message);
    return;
  }
  // `name` is the label of the setting a too-short refusal is about.
  toast.warning(t(text.key, { ...text.values, name: text.paramNameKey === undefined ? '' : t(text.paramNameKey) }));
}
