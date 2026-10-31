// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import type { SlugCheck } from '@web/pages/studio/container/dialogs/slug-util';

/**
 * Hold a submit pressed while the studio slug is still being checked, and try
 * it again once the check has an answer (inner#1652). The button stays
 * pressable throughout, so a press that beats the debounced check must not be
 * lost, nor go out on a slug nobody has checked.
 *
 * The wait ends without a retry when the slug changes or the form closes;
 * unmounting ends it with the component. The retry calls the latest
 * `onSettled`, so it reads the values on screen at that moment.
 * @param check - Where the slug stands now.
 * @param slug - The slug field's current value.
 * @param active - Whether the form is on screen (a dialog's `open`).
 * @param onSettled - The whole submit, run again once the check settles.
 * @returns Whether a press is waiting, and `start` to begin waiting.
 */
export function useWaitForSlugCheck(
  check: SlugCheck,
  slug: string,
  active: boolean,
  onSettled: () => void,
): { waiting: boolean; start: () => void } {
  const [waitingFor, setWaitingFor] = React.useState<string | null>(null);
  const settled = React.useRef(onSettled);
  React.useEffect(() => {
    settled.current = onSettled;
  });
  const trimmed = slug.trim();

  React.useEffect(() => {
    if (waitingFor === null) return;
    if (!active || trimmed !== waitingFor) {
      setWaitingFor(null);
      return;
    }
    if (check.state === 'checking') return;
    setWaitingFor(null);
    settled.current();
  }, [active, check.state, trimmed, waitingFor]);

  const start = React.useCallback((): void => setWaitingFor(trimmed), [trimmed]);
  return { waiting: waitingFor !== null, start };
}
