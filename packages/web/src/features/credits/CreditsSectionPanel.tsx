// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { CreditsSectionId } from '@web/features/credits/credits-sections';
import { useCreditOverview } from '@web/features/credits/use-credit-overview';
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

/** Which section to show. */
interface CreditsSectionPanelProps {
  /** The section the reader picked. */
  section: CreditsSectionId;
}

/**
 * Whichever section is showing, with the overview it needs.
 *
 * The overview is read once for all seven rather than by each: four of them
 * display it and the other three need only the one flag it carries, and it is
 * a single row's worth of totals that would otherwise be re-read on every
 * click of the index.
 * @param props - Which section to show.
 * @param props.section - The section the reader picked.
 * @returns The section.
 */
export function CreditsSectionPanel({
  section,
}: CreditsSectionPanelProps): React.JSX.Element {
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);
  // Always on: this panel is mounted by a portal that unmounts on close, so
  // its existence already means somebody is looking.
  const overview = useCreditOverview(true);

  // `isPending` and not `isLoading`: an offline first read is paused rather
  // than fetching, which leaves `isLoading` false with no data in hand.
  // Padded here rather than by `Section`, which neither of these reaches: the
  // panel holds no inset of its own, so without this they are drawn against
  // the dialog's edges.
  if (overview.isPending) {
    return (
      <div className='p-7'>
        <SectionSkeleton />
      </div>
    );
  }
  if (overview.isError) {
    return (
      <div className='p-7'>
        <SectionError />
      </div>
    );
  }

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
