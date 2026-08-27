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
import { RuleLines, formatMoney } from '@web/features/credits/section-chrome';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';

/** The pack being confirmed, and what the dialog reports. */
interface BuyConfirmDialogProps {
  /** The chosen pack, or null when the dialog is closed. */
  pack: CreditPack | null;
  /** The refund rule, in the reader's language, as the server hands it over. */
  refundLines: readonly string[];
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
 * The refund-rule tick lives here rather than under the packs, because it
 * belongs to one purchase: a tick sitting on the screen would be set once and
 * then carried, unnoticed, into every purchase after it. This dialog starts
 * unticked every time it opens, so it is the purchase in front of the buyer
 * that gets acknowledged.
 *
 * It states the pack, what lands, and that the price excludes tax — the three
 * things a buyer would otherwise first learn on somebody else's page.
 *
 * The rule itself is here as well as on the screen behind, because a modal
 * dialog covers that screen twice over: an opaque scrim goes across it and
 * `aria-hidden` takes it out of the accessibility tree. Ticking that the rule
 * has been read, with the rule neither visible nor readable, is being asked to
 * take our word for it.
 * @param props - The pack, the rule and the callbacks.
 * @param props.pack - The chosen pack, or null when closed.
 * @param props.refundLines - The refund rule, in the reader's language.
 * @param props.onOpenChange - Called when the dialog closes itself.
 * @param props.onConfirm - Called with the pack once confirmed.
 * @returns The dialog.
 */
export function BuyConfirmDialog({
  pack,
  refundLines,
  onOpenChange,
  onConfirm,
}: BuyConfirmDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [starting, setStarting] = React.useState(false);

  // Every purchase is confirmed on its own. Reopening on a different pack with
  // the previous tick still set would carry one purchase's acknowledgement
  // into the next.
  React.useEffect(() => {
    if (pack !== null) {
      setAcknowledged(false);
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

        {refundLines.length === 0 ? null : (
          <div className='flex flex-col gap-2'>
            <h3 className='text-sm font-semibold'>
              {t('credits.buy.refundTitle')}
            </h3>
            <RuleLines
              data-testid='confirm-refund-rule'
              lines={refundLines}
            />
          </div>
        )}

        <label className='flex items-start gap-2 text-sm'>
          <Checkbox
            data-testid='confirm-refund-ack'
            checked={acknowledged}
            onCheckedChange={(next) => {
              setAcknowledged(next === true);
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
            disabled={!acknowledged || starting}
            onClick={confirm}
          >
            {t('credits.buy.pay')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
