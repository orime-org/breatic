// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import { fetchCreditOverview } from '@web/data/api/credits';
import type { CreditsSectionId } from '@web/features/credits/credits-sections';
import {
  SectionError,
  SectionSkeleton,
} from '@web/features/credits/section-chrome';
import { AssignSection } from '@web/features/credits/sections/AssignSection';
import { BuySection } from '@web/features/credits/sections/BuySection';
import { LedgerSection } from '@web/features/credits/sections/LedgerSection';
import { PurchasesSection } from '@web/features/credits/sections/PurchasesSection';
import { OverviewSection } from '@web/features/credits/sections/OverviewSection';
import { RefundsSection } from '@web/features/credits/sections/RefundsSection';
import { StudiosSection } from '@web/features/credits/sections/StudiosSection';
import { useCurrentUserStore } from '@web/stores/current-user';

/** Which section to show, and whether the overlay is open. */
interface CreditsSectionPanelProps {
  /** The section the reader picked. */
  section: CreditsSectionId;
  /** Whether the overlay is open, which is when anything is read. */
  open: boolean;
}

/**
 * Whichever section is showing, with the overview it needs.
 *
 * The overview is read once for all seven rather than by each: four of them
 * display it and the other three need only the one flag it carries, and it is
 * a single row's worth of totals that would otherwise be re-read on every
 * click of the index.
 *
 * Its key carries the account, the way the membership panel's does: the query
 * client is a module singleton that a sign-out never clears, so a key without
 * the account would hand the next person to sign in on this tab the last
 * one's figures.
 * @param props - The section and whether the overlay is open.
 * @param props.section - The section the reader picked.
 * @param props.open - Whether the overlay is open.
 * @returns The section.
 */
export function CreditsSectionPanel({
  section,
  open,
}: CreditsSectionPanelProps): React.JSX.Element {
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);
  const overview = useQuery({
    queryKey: ['credits', 'overview', userId],
    queryFn: () => fetchCreditOverview(),
    enabled: open && userId !== null,
  });

  // `isPending` and not `isLoading`: an offline first read is paused rather
  // than fetching, which leaves `isLoading` false with no data in hand.
  if (overview.isPending) return <SectionSkeleton />;
  if (overview.isError) return <SectionError />;

  const data = overview.data;
  switch (section) {
    case 'overview':
      return <OverviewSection overview={data} />;
    case 'lots':
      return <PurchasesSection userId={userId} billing={data.billing} />;
    case 'ledger':
      return <LedgerSection userId={userId} overview={data} />;
    case 'studios':
      return <StudiosSection overview={data} />;
    case 'buy':
      return <BuySection overview={data} />;
    case 'assign':
      return <AssignSection userId={userId} billing={data.billing} />;
    case 'refunds':
      return <RefundsSection userId={userId} billing={data.billing} />;
  }
}
