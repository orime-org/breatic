// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Checkbox } from '@web/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
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

/**
 * Where the stored legal wording marks the clause it stresses.
 *
 * The same string is read in three places — this dialog, the plain-text
 * confirmation and the HTML one — and each renders the emphasis its own way.
 * Reaching a reader untranslated, the markers are asterisks in the middle of
 * the sentence the buyer is agreeing to.
 */
const EMPHASIS = /\*\*(.+?)\*\*/g;

/**
 * The stored wording with its emphasis rendered.
 *
 * Split rather than set as markup: the sentence is ours, but putting any
 * string into the DOM as HTML is a habit this codebase does not keep.
 *
 * The weight is pinned. Preflight ships `strong { font-weight: bolder }`, and
 * `bolder` steps up from the inherited weight, so the same mark lands on a
 * different weight depending on what it sits inside — measured here as 900
 * under a 600 parent, while the repository's own scale stops at 700. The two
 * other renderers of this markup pin it the same way (`index.css`, for the
 * document body and the chat).
 * @param text - The stored wording, as the server hands it over.
 * @returns The words, with the stressed clause in `<strong>`.
 */
function withEmphasis(text: string): React.ReactNode[] {
  return text.split(EMPHASIS).map((part, index) =>
    // `split` on a capturing group alternates: plain, captured, plain…
    index % 2 === 0 ? (
      part
    ) : (
      <strong className='font-bold' key={`${String(index)}-${part}`}>
        {part}
      </strong>
    ),
  );
}

/** The pack being confirmed, and what the dialog reports. */
interface BuyConfirmDialogProps {
  /** The chosen pack, or null when the dialog is closed. */
  pack: CreditPack | null;
  /** The refund rule, in the reader's language, as the server hands it over. */
  refundLines: readonly string[];
  /**
   * The sentence the tick stands for, in the reader's language, as the server
   * hands it over. It is recorded against the purchase by version, so the
   * wording shown and the wording recorded come from the same place.
   */
  consentText: string;
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
 * The consent tick lives here rather than under the packs, for two reasons.
 * It belongs to one purchase: a tick sitting on the screen would be set once
 * and then carried, unnoticed, into every purchase after it, and this dialog
 * starts unticked every time it opens. And it is the step that stands between
 * the buyer and paying — showing the sentence somewhere they can walk past is
 * not the same as their agreeing to it.
 *
 * It states the pack, what lands, and that the price excludes tax — the three
 * things a buyer would otherwise first learn on somebody else's page.
 *
 * The rule itself is here as well as on the screen behind, because a modal
 * dialog covers that screen twice over: an 80%-black scrim goes across it and
 * `aria-hidden` takes it out of the accessibility tree. The sentence being
 * agreed to states when a purchase stops being refundable, and the rule it
 * refers to would otherwise be neither visible nor readable at the moment of
 * agreeing.
 * @param props - The pack, the rule and the callbacks.
 * @param props.pack - The chosen pack, or null when closed.
 * @param props.refundLines - The refund rule, in the reader's language.
 * @param props.consentText - The sentence the tick stands for.
 * @param props.onOpenChange - Called when the dialog closes itself.
 * @param props.onConfirm - Called with the pack once confirmed.
 * @returns The dialog.
 */
export function BuyConfirmDialog({
  pack,
  refundLines,
  consentText,
  onOpenChange,
  onConfirm,
}: BuyConfirmDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [consented, setConsented] = React.useState(false);
  const [starting, setStarting] = React.useState(false);

  // Every purchase is confirmed on its own. Reopening on a different pack with
  // the previous tick still set would carry one purchase's consent
  // into the next.
  React.useEffect(() => {
    if (pack !== null) {
      setConsented(false);
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

        <DialogBody>
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
              data-testid='confirm-consent'
              checked={consented}
              onCheckedChange={(next) => {
                setConsented(next === true);
              }}
            />
            {/* The server's wording, verbatim. Holding a copy here would let
                the sentence shown drift from the version recorded against the
                purchase, and the record would then name wording nobody read. */}
            <span>{withEmphasis(consentText)}</span>
          </label>
        </DialogBody>

        <DialogFooter>
          <Button variant='outline' onClick={cancel}>
            {t('credits.buy.cancel')}
          </Button>
          <Button
            data-testid='confirm-pay'
            disabled={!consented || starting}
            onClick={confirm}
          >
            {t('credits.buy.pay')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
