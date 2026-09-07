// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@web/components/ui/dialog';
import { useTranslation } from '@web/i18n/use-translation';

/** Whether the wait is up, and where the one control goes. */
interface CheckoutWaitOverlayProps {
  /** Whether to cover the page. */
  open: boolean;
  /**
   * Land the buyer in their purchase history, which is where the wait goes on
   * its own once it times out.
   */
  onSkip: () => void;
}

/**
 * The page while a purchase is being settled.
 *
 * It covers everything: the buyer is waiting on the result of a payment, and
 * nothing else they could start right now should begin before they know it.
 * Escape and a click outside do not lift it — `open` is controlled and no
 * `onOpenChange` is given, so every way Radix has of closing itself runs
 * through a callback that is not there.
 *
 * What it does carry is one control, going where the wait goes on its own once
 * it times out. A modal dialog holds the focus ring inside itself, so a cover
 * with nothing focusable on it is a cover a keyboard cannot get out of — the
 * trap WCAG 2.1.2 forbids. Nothing is given up by having it: the payment is
 * settled either way, by the webhook and by the reconcile pass, and the
 * purchase history is where it reads as processing.
 * @param props - Whether the wait is up, and where the control goes.
 * @param props.open - Whether to cover the page.
 * @param props.onSkip - Land the buyer in their purchase history.
 * @returns The cover.
 */
export function CheckoutWaitOverlay({
  open,
  onSkip,
}: CheckoutWaitOverlayProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <Dialog open={open}>
      <DialogContent data-testid='checkout-wait' className='max-w-sm'>
        <div className='flex flex-col items-center gap-3 py-2 text-center'>
          <Loader2 className='size-6 animate-spin text-muted-foreground' />
          <DialogTitle>{t('credits.checkoutWait.title')}</DialogTitle>
          <DialogDescription>
            {t('credits.checkoutWait.body')}
          </DialogDescription>
          <Button
            data-testid='checkout-wait-skip'
            variant='outline'
            size='sm'
            onClick={onSkip}
          >
            {t('credits.checkoutWait.skip')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
