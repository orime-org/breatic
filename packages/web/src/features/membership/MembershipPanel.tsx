// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { X } from 'lucide-react';
import { isComparableMembershipTier } from '@breatic/shared';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@web/components/ui/dialog';
import { accountApi } from '@web/data/api/account';
import { membershipQueryKey } from '@web/features/membership/membership-query';
import {
  MembershipContent,
  MembershipLoading,
} from '@web/features/membership/MembershipContent';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { useCurrentUserStore } from '@web/stores/current-user';

/** Whether the panel is open, and how it reports being closed. */
interface MembershipPanelProps {
  /** Whether the panel is showing. */
  open: boolean;
  /** Called when the panel closes itself (the X, the backdrop, Escape). */
  onOpenChange: (open: boolean) => void;
}

/**
 * The account's membership, over whatever page the reader was on.
 *
 * A panel rather than a page, and it has no URL of its own. A person opening
 * this is checking something, not going somewhere: whatever they were doing —
 * including a half-filled form — is still underneath and still theirs when
 * they close it. The address bar keeps naming the page below, and a reload
 * returns to that page.
 *
 * It is wider than the dialog default because the comparison table has four
 * columns, and its height follows its content: the enterprise state is two
 * short sections while a priced tier carries the whole table, and a fixed
 * height would leave the short ones mostly empty.
 * @param props - Whether the panel is open, and how it reports closing.
 * @param props.open - Whether the panel is showing.
 * @param props.onOpenChange - Called when the panel closes itself.
 * @returns The panel.
 */
export function MembershipPanel({
  open,
  onOpenChange,
}: MembershipPanelProps): React.JSX.Element {
  const t = useTranslation();
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);
  const knownTier = useCurrentUserStore((s) => s.user?.membershipTier ?? null);
  const query = useQuery({
    queryKey: membershipQueryKey(userId),
    queryFn: () => accountApi.membership(),
    enabled: open && userId !== null,
  });
  // A priced tier's loaded panel runs to about 1000px (measured: PRO yearly,
  // English, 1005px uncapped), so the dialog takes that height from the first
  // frame and keeps it: nothing moves when the answer lands. The unpriced
  // tiers are short either way and size to their content.
  const shownTier = query.data?.tier ?? knownTier;
  const pinned = shownTier !== null && isComparableMembershipTier(shownTier);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Two rows: the current tier, which stays put, and everything under
          it, which scrolls. Grid rather than the flex column the primitive
          ships as, because an unpriced tier's ceiling is a `max-height`: a
          flex column under one leaves its items at `height: auto`, the viewport grows to its
          content, and the panel clips instead of scrolling. Grid tracks are
          definite either way (`MembersModal` measured the same trap). */}
      <DialogContent
        className={cn(
          'grid w-[min(880px,calc(100vw-80px))] max-w-none grid-rows-[auto_minmax(0,1fr)] bg-background p-0',
          pinned ? 'h-[min(1000px,calc(100vh-80px))]' : 'max-h-[calc(100vh-80px)]',
        )}
      >
        {/* The panel's own heading is the tier itself, which is why there is
            no visible title bar; the accessible name still has to exist, and
            Radix requires it. */}
        <DialogTitle className='sr-only'>
          {t('membership.panelTitle')}
        </DialogTitle>
        <DialogClose
          aria-label={t('membership.close')}
          className='absolute right-4 top-4 inline-flex h-[var(--btn-chrome)] w-[var(--btn-chrome)] items-center justify-center rounded-chrome text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <X className='h-[18px] w-[18px]' />
        </DialogClose>
        {query.isPending ? (
          <MembershipLoading tier={knownTier} />
        ) : query.isError ? (
          // One line, the way the sibling studio pages report a failed read
          // (StudioContainerPage / StudioRecentPage). No retry button:
          // closing and reopening the panel refetches, and this read has
          // nothing the reader would lose by doing that. Panels that DO
          // offer one (node history, the decision landing page) are ones
          // where the reader is mid-task and reopening costs them that.
          <p role='alert' className='p-8 text-sm text-muted-foreground'>
            {t('membership.loadFailed')}
          </p>
        ) : (
          <MembershipContent membership={query.data} />
        )}
      </DialogContent>
    </Dialog>
  );
}
