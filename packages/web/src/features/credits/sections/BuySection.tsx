// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { getLocale } from '@breatic/shared';
import type { CreditOverview } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { paymentApi } from '@web/data/api/payment';
import type { CreditPack } from '@web/data/api/payment';
import { BuyConfirmDialog } from '@web/features/credits/sections/BuyConfirmDialog';
import {
  Card,
  Figure,
  Footnote,
  Notice,
  RuleLines,
  Section,
  SectionError,
  SectionSkeleton,
  formatMoney,
} from '@web/features/credits/section-chrome';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { toast } from '@web/lib/toast';

/** The overview to read a balance from. */
interface BuySectionProps {
  /** What the account holds, and where. */
  overview: CreditOverview;
}

/**
 * Where credits are bought.
 *
 * This screen only starts a purchase. Where one stands afterwards belongs to
 * the purchase history, and answering it in two places would give a buyer two
 * things to believe.
 *
 * Three blocks sit under the packs, all of them things a buyer has to have
 * read before they reach Stripe: the price on the card is not what their card
 * is charged, credits do nothing until they are pointed at a Studio, and the
 * refund rule in full — the one the confirmation dialog's consent refers to.
 * @param props - The overview.
 * @param props.overview - What the account holds, and where.
 * @returns The section.
 */
export function BuySection({ overview }: BuySectionProps): React.JSX.Element {
  const t = useTranslation();
  const total = overview.assignedCredits + overview.unassignedCredits;
  const [chosen, setChosen] = React.useState<CreditPack | null>(null);

  const packs = useQuery({
    // The refund rule comes back in the reader's language, so the language is
    // part of what was asked for. Left out of the key, switching language
    // leaves that block in the previous one until the answer goes stale.
    queryKey: ['payment', 'tiers', getLocale()],
    queryFn: () => paymentApi.tiers(),
    enabled: overview.billing,
    staleTime: 5 * 60 * 1000,
  });

  const start = React.useCallback(async (pack: CreditPack): Promise<boolean> => {
    try {
      const { url } = await paymentApi.checkout({
        price_cents: pack.priceCents,
        // Both ways back are derived from this one: Stripe substitutes the
        // session id into one and the server writes our own row's id into the
        // other, so the landing page can tell which way it was.
        return_url: window.location.href,
        // Nothing later in the chain knows this. A webhook carries no hint of
        // it, and the confirmation email prints the purchase time in it.
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // Reaching here means the dialog's tick is set: it is what releases
        // the button this runs from. The server stamps the instant it
        // arrives, and refuses a request that does not carry it.
        consented: true,
      });
      window.location.assign(url);
      return true;
    } catch {
      toast.error(t('credits.buy.failed'));
      return false;
    }
  }, [t]);

  const close = React.useCallback((open: boolean): void => {
    if (!open) setChosen(null);
  }, []);

  if (!overview.billing) {
    return (
      <Section title={t('credits.section.buy')}>
        <Notice
          title={t('credits.billingOff.title')}
          body={t('credits.billingOff.body')}
          tone='info'
        />
      </Section>
    );
  }

  return (
    <Section title={t('credits.section.buy')}>
      <Figure
        label={t('credits.total')}
        value={formatCreditAmount(total)}
        unit={t('credits.unit')}
        hint={t('credits.pricingHint')}
      />
      {packs.isPending ? (
        <SectionSkeleton />
      ) : packs.isError ? (
        <SectionError />
      ) : (
        <div className='grid grid-cols-5 gap-2'>
          {packs.data.packs.map((pack) => (
            <PackCard key={pack.priceCents} pack={pack} onChoose={setChosen} />
          ))}
        </div>
      )}
      <Footnote data-testid='buy-tax-notice'>
        {t('credits.buy.taxNotice')}
      </Footnote>
      <Footnote data-testid='buy-assign-notice'>
        {t('credits.buy.assignNotice')}
      </Footnote>
      {/* The consent in the confirmation dialog states when a purchase stops
          being refundable, so the rule behind it has to be readable on the
          screen that leads there. */}
      {packs.isSuccess ? (
        <div data-testid='buy-refund-rule'>
          <Card title={t('credits.buy.refundTitle')}>
            <RuleLines lines={packs.data.refundLines} />
          </Card>
        </div>
      ) : null}
      <BuyConfirmDialog
        pack={chosen}
        refundLines={packs.data?.refundLines ?? []}
        consentText={packs.data?.consentText ?? ''}
        onOpenChange={close}
        onConfirm={start}
      />
    </Section>
  );
}

/** One pack and how it reports being chosen. */
interface PackCardProps {
  /** The pack. */
  pack: CreditPack;
  /** Called with it when the buyer picks it. */
  onChoose: (pack: CreditPack) => void;
}

/**
 * One pack: what it costs and what it grants, and nothing else.
 *
 * No per-credit figure. A buyer choosing between five packs is choosing how
 * much to spend, and a third number invites arithmetic instead.
 * @param props - The pack and its callback.
 * @param props.pack - The pack.
 * @param props.onChoose - Called with it when the buyer picks it.
 * @returns The card.
 */
const PackCard = React.memo(function PackCard({
  pack,
  onChoose,
}: PackCardProps): React.JSX.Element {
  const t = useTranslation();
  const choose = React.useCallback(() => {
    onChoose(pack);
  }, [onChoose, pack]);

  return (
    <div
      data-testid='credit-pack'
      className='flex flex-col gap-2 rounded-content-md border border-border p-3'
    >
      <span className='text-lg font-semibold'>
        {formatMoney(pack.priceCents, pack.currency)}
      </span>
      <span className='text-xs text-muted-foreground'>
        {formatCreditAmount(pack.credits)} {t('credits.unit')}
      </span>
      <Button variant='outline' size='sm' className='mt-auto' onClick={choose}>
        {t('credits.buy.action')}
      </Button>
    </div>
  );
});
