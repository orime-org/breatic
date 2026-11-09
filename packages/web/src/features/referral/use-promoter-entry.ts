// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useCurrentUserStore } from '@web/stores/current-user';
import { promoterEntryAction, referralQueryOptions, useAccountReferral } from '@web/features/referral/referral-query';

export interface PromoterEntry {
  /** Whether the account menu lists the entry: everywhere except a deployment that takes no payments. */
  shown: boolean;
  /** Whether the promoter dialog is open. */
  dialogOpen: boolean;
  /** Opens or closes the promoter dialog. */
  setDialogOpen: (open: boolean) => void;
  /** What choosing the entry does: say the program is closed, or open the dialog. */
  select: () => void;
}

/**
 * The account menu's "Promoter program" entry (inner#1868).
 *
 * The referral view is read while the menu is open, as the credits figure is,
 * so pages nobody opens the menu on spend no request. Choosing the entry before
 * that read answers waits for it; a failed read opens the dialog, which offers
 * a retry.
 * @param menuOpen - Whether the account menu is open.
 * @returns The entry's state and its action.
 */
export function usePromoterEntry(menuOpen: boolean): PromoterEntry {
  const t = useTranslation();
  const client = useQueryClient();
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);
  const { data } = useAccountReferral(menuOpen);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const closedNotice = t('promoter.closed');

  const select = React.useCallback((): void => {
    client.ensureQueryData(referralQueryOptions(userId)).then(
      (view) => {
        if (view === null) return;
        if (promoterEntryAction(view) === 'closed') toast.info(closedNotice);
        else setDialogOpen(true);
      },
      () => setDialogOpen(true),
    );
  }, [client, userId, closedNotice]);

  return { shown: data !== null, dialogOpen, setDialogOpen, select };
}
