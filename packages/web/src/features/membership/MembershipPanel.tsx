// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { X } from 'lucide-react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@web/components/ui/dialog';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import { accountApi } from '@web/data/api/account';
import { MembershipContent } from '@web/features/membership/MembershipContent';
import { useTranslation } from '@web/i18n/use-translation';
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
  // Keyed on the account, the way the notification inbox is. Without it, one
  // account's tier and storage figures sit in the cache under a name the next
  // account signing in on this tab matches exactly — and the client is a
  // module singleton that a client-side sign-out never clears, so the second
  // person would read the first one's billing figures.
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);
  const query = useQuery({
    queryKey: ['account', 'membership', userId],
    queryFn: () => accountApi.membership(),
    enabled: open && userId !== null,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[calc(100vh-80px)] w-[min(880px,calc(100vw-80px))] max-w-none bg-background p-0'>
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
        <ScrollArea className='max-h-[calc(100vh-80px)]' viewportClassName='p-8'>
          {query.isPending ? (
            <MembershipSkeleton />
          ) : query.isError ? (
            // One line, the way the sibling studio pages report a failed read.
            // There is no retry button anywhere in this product's read
            // failures, and reopening the panel is the retry.
            <p role='alert' className='text-sm text-muted-foreground'>
              {t('membership.loadFailed')}
            </p>
          ) : (
            <MembershipContent membership={query.data} />
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The panel's shape while its one request is in flight.
 *
 * A skeleton and not a spinner: the layout does not depend on the answer, so
 * showing it early means the reader is already looking at the right place
 * when the numbers arrive.
 * @returns The placeholder.
 */
function MembershipSkeleton(): React.JSX.Element {
  return (
    <div className='flex flex-col gap-8' data-testid='membership-skeleton'>
      <section className='flex flex-col gap-4'>
        <Skeleton className='h-3 w-20' />
        <Skeleton className='h-7 w-36' />
        <Skeleton className='h-3.5 w-full' />
      </section>
      <section className='flex flex-col gap-4'>
        <Skeleton className='h-3 w-20' />
        <Skeleton className='h-8 w-full' />
        <Skeleton className='h-8 w-full' />
      </section>
      <section className='flex flex-col gap-4'>
        <Skeleton className='h-3 w-20' />
        <Skeleton className='h-56 w-full' />
      </section>
    </div>
  );
}
