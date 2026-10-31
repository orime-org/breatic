// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { t } from '@breatic/shared';

import { toast } from '@web/lib/toast';

interface AtLimitNotice {
  /** Say it, for a keystroke the box has just refused in silence. */
  sayAgain: () => void;
}

/**
 * Saying, on the moment it happens, that the box will take no more.
 *
 * A thing that happened rather than a state the box is in, so it is a toast
 * (inner#1530): said when the text first reaches the limit, and again for
 * every keystroke turned away after that -- the box's limit turns it away
 * without changing anything on screen, so a reader who kept typing past the
 * first time would otherwise be typing into silence. A draft that was full
 * when the box opened says nothing: that did not just happen.
 * @param length - How long the draft is.
 * @param limit - How long it may be.
 * @returns A way to say it again.
 */
export function useAtLimitNotice(length: number, limit: number): AtLimitNotice {
  const full = length >= limit;
  const wasFull = React.useRef(full);

  const sayAgain = React.useCallback(() => {
    toast.warning(t('chat.composer.atLimit', { limit }));
  }, [limit]);

  React.useEffect(() => {
    if (full && !wasFull.current) sayAgain();
    wasFull.current = full;
  }, [full, sayAgain]);

  return { sayAgain };
}
