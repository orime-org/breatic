// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@web/components/ui/dialog';
import { useTranslation } from '@web/i18n/use-translation';

/** Whether the wait is up. */
interface CheckoutWaitOverlayProps {
  /** Whether to cover the page. */
  open: boolean;
}

/**
 * The page while a purchase is being settled.
 *
 * It covers everything and takes no input: the buyer is waiting on the result
 * of a payment, and nothing else they could start right now should begin
 * before they know it. There is no way to dismiss it — the hook that raises it
 * also takes it down, on an answer or on a timeout, so a buyer is never left
 * behind a cover that has stopped meaning anything.
 * @param props - Whether the wait is up.
 * @param props.open - Whether to cover the page.
 * @returns The cover.
 */
export function CheckoutWaitOverlay({
  open,
}: CheckoutWaitOverlayProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <Dialog open={open}>
      <DialogContent
        data-testid='checkout-wait'
        className='max-w-sm [&>button]:hidden'
        onEscapeKeyDown={(event) => {
          event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          event.preventDefault();
        }}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
      >
        <div className='flex flex-col items-center gap-3 py-2 text-center'>
          <Loader2 className='size-6 animate-spin text-muted-foreground' />
          <DialogTitle>{t('credits.checkoutWait.title')}</DialogTitle>
          <DialogDescription>
            {t('credits.checkoutWait.body')}
          </DialogDescription>
        </div>
      </DialogContent>
    </Dialog>
  );
}
