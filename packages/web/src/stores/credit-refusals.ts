// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The two refusals the monthly operations and spend limits bring
 * (inner#1968, design 3.3 and 3.10), said the same way at every entry.
 *
 * Used-up operations are said in the server's words when it sent them, and
 * offer a top-up that opens the credits overlay. A spend limit is said with
 * its limit and reset day and offers none: adding credits does not lift it.
 */

import { t } from '@breatic/shared';

import { ApiException } from '@web/data/api/types';
import { spendCapMessage } from '@web/lib/spend-cap-message';
import { toast } from '@web/lib/toast';
import { useUIStore } from '@web/stores/ui';

/** The exclusive overlay id the credits overlay opens under. */
export const CREDITS_OVERLAY_ID = 'credits-overlay';

/** The server's reason for a refusal past the month's operations. */
const OPERATIONS_EXHAUSTED = 'operations_exhausted';

/** The server's reason for a refusal past a spend limit. */
const SPEND_CAP_REACHED = 'spend_cap_reached';

/** A toast action. */
export interface TopUpAction {
  label: string;
  onClick: () => void;
}

/**
 * Open the credits overlay over whatever page is showing.
 */
export function openCreditsOverlay(): void {
  useUIStore.getState().setActiveOverlayId(CREDITS_OVERLAY_ID);
}

/**
 * The top-up action a used-up refusal carries.
 * @returns The action.
 */
export function topUpAction(): TopUpAction {
  return { label: t('credits.topUp'), onClick: openCreditsOverlay };
}

/**
 * Whether a failure is the refusal past the month's operations.
 * @param err - What a request rejected with.
 * @returns True for that refusal.
 */
export function isOperationsExhausted(err: unknown): boolean {
  return err instanceof ApiException && err.reason === OPERATIONS_EXHAUSTED;
}

/**
 * Whether a failure is the refusal past a spend limit.
 * @param err - What a request rejected with.
 * @returns True for that refusal.
 */
export function isSpendCapReached(err: unknown): boolean {
  return err instanceof ApiException && err.reason === SPEND_CAP_REACHED;
}

/**
 * What one of the two refusals says, or null for any other failure.
 * @param err - What a request rejected with.
 * @returns The sentence, in the user's language, or null.
 */
export function refusalSentence(err: unknown): string | null {
  if (!(err instanceof ApiException)) return null;
  if (err.reason === OPERATIONS_EXHAUSTED) {
    return err.fromServer && err.message ? err.message : t('credits.refusal.operations');
  }
  if (err.reason !== SPEND_CAP_REACHED) return null;
  const { scope, limit, resetsAt } = err.details ?? {};
  if ((scope !== 'member' && scope !== 'studio') || typeof resetsAt !== 'string') {
    return err.fromServer && err.message ? err.message : t('credits.refusal.spendCap');
  }
  return spendCapMessage(SPEND_CAP_REACHED, scope, typeof limit === 'string' ? limit : String(limit ?? ''), resetsAt);
}

/**
 * Say a failure in an error toast, with the top-up a used-up refusal offers.
 * @param message - The sentence.
 * @param err - What the request rejected with.
 */
export function toastFailure(message: string, err: unknown): void {
  if (isOperationsExhausted(err)) toast.error(message, { action: topUpAction() });
  else toast.error(message);
}
