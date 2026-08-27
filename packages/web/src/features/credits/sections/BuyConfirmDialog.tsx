// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import type { CreditPack } from '@web/data/api/payment';
import { formatMoney } from '@web/features/credits/section-chrome';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';

/** The pack being confirmed, and what the dialog reports. */
interface BuyConfirmDialogProps {
  /** The chosen pack, or null when the dialog is closed. */
  pack: CreditPack | null;
  /** Called when the dialog closes itself. */
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the pack once the buyer confirms. Answers whether the buyer
   * is on their way to Stripe; a false answer leaves the dialog open and
   * usable, because there is nothing else for them to do here but try again.
   */
  onConfirm: (pack: CreditPack) => Promise<boolean>;
}

/**
 * The step between choosing a pack and reaching Stripe.
 *
 * The consent tick lives here rather than under the packs, because it is the
 * confirmation of one purchase: a tick sitting on the screen would be agreed
 * to once and then carried, unnoticed, into every purchase after it. This
 * dialog starts unticked every time it opens, so the agreement belongs to the
 * purchase in front of the buyer.
 *
 * It states the pack, what lands, and that the price excludes tax — the three
 * things a buyer would otherwise first learn on somebody else's page.
 * @param props - The pack and the callbacks.
 * @param props.pack - The chosen pack, or null when closed.
 * @param props.onOpenChange - Called when the dialog closes itself.
 * @param props.onConfirm - Called with the pack once confirmed.
 * @returns The dialog.
 */
export function BuyConfirmDialog({
  pack,
  onOpenChange,
  onConfirm,
}: BuyConfirmDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [agreed, setAgreed] = React.useState(false);
  const [starting, setStarting] = React.useState(false);

  // Every purchase is confirmed on its own. Reopening on a different pack with
  // the previous tick still set would carry an agreement across purchases.
  React.useEffect(() => {
    if (pack !== null) {
      setAgreed(false);
      setStarting(false);
    }
  }, [pack]);

  const confirm = React.useCallback(async (): Promise<void> => {
    if (pack === null) return;
    setStarting(true);
    // Left disabled on success: the browser is leaving for Stripe, and a
    // button that comes back to life during that moment is one a second tap
    // can reach.
    if (!(await onConfirm(pack))) setStarting(false);
  }, [onConfirm, pack]);

  const cancel = React.useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={pack !== null} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('credits.buy.confirmTitle')}</DialogTitle>
          <DialogDescription data-testid='confirm-tax-note'>
            {t('credits.buy.confirmTax')}
          </DialogDescription>
        </DialogHeader>

        {pack === null ? null : (
          <dl className='grid grid-cols-2 gap-y-2 text-sm'>
            <dt className='text-muted-foreground'>
              {t('credits.buy.confirmPack')}
            </dt>
            <dd className='text-right font-semibold'>
              {formatMoney(pack.priceCents, pack.currency)}
            </dd>
            <dt className='text-muted-foreground'>
              {t('credits.buy.confirmCredits')}
            </dt>
            <dd className='text-right font-semibold'>
              {formatCreditAmount(pack.credits)} {t('credits.unit')}
            </dd>
          </dl>
        )}

        <label className='flex items-start gap-2 text-sm'>
          <Checkbox
            data-testid='confirm-consent'
            checked={agreed}
            onCheckedChange={(next) => {
              setAgreed(next === true);
            }}
          />
          {/* One sentence, one key. Split into its clauses it was joined by
              spaces written here, and where a clause joins the next is a
              question about the language, not about this layout — every
              non-English locale rendered the sentence with English spacing. */}
          <span>{t('credits.buy.consent')}</span>
        </label>

        <DialogFooter>
          <Button variant='outline' onClick={cancel}>
            {t('credits.buy.cancel')}
          </Button>
          <Button
            data-testid='confirm-pay'
            disabled={!agreed || starting}
            onClick={confirm}
          >
            {t('credits.buy.pay')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
