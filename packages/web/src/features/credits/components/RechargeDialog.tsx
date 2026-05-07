/**
 * RechargeDialog — credit-pack purchase modal.
 *
 * Layout follows the Direction B mock: a balance summary header on
 * top, a responsive grid of tier cards below. Each card shows credits,
 * price, and a per-100-credit unit price for comparison.
 *
 * Tiers come from the backend `GET /payment/tiers` (sourced from
 * `config/pricing.yaml`). The frontend does NOT hardcode pack sizes
 * or prices — that's the canonical config's job. Each tier's display
 * name is i18n-keyed by tier `name`, falling back to the raw name
 * if no key exists (so adding a new tier on the backend ships
 * without an immediate locale update).
 *
 * Clicking a tier creates a Stripe Checkout session and redirects
 * the browser to its URL. On return, Stripe's webhook credits the
 * account; the user lands back at `success_url` (this project page)
 * with `?payment=success`. (The post-redirect refresh of the credits
 * pill is the responsibility of the project page, not this dialog.)
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Dialog from '@/ui/dialog';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';
import * as paymentApi from '@/data/api/payment';
import type { PricingTier } from '@/data/api/payment';
import { cn } from '@/utils/classnames';

const StarGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26" />
  </svg>
);

export interface RechargeDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Translate a tier name with graceful fallback to the raw name. The
 * dialog imports the i18n helper rather than relying on the locale
 * file having every tier — that way adding a new tier in the backend
 * doesn't break the UI before locales catch up.
 */
function useTierLabel() {
  const { t, i18n } = useTranslation();
  return (tierName: string) => {
    const key = `credits.dialog.tier.${tierName}`;
    return i18n.exists(key) ? t(key) : tierName;
  };
}

const RechargeDialog: React.FC<RechargeDialogProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const labelFor = useTierLabel();
  const { userInfo } = useUserCenterStore();
  const balance = userInfo?.total_credits ?? 0;

  const [tiers, setTiers] = useState<PricingTier[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingTier, setPendingTier] = useState<string | null>(null);

  // Lazy fetch — only when dialog opens.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    paymentApi
      .getTiers()
      .then((res) => {
        // Endpoint returns a bare array (no ApiResponse envelope);
        // tolerate either shape so a future contract change doesn't
        // silently break the dialog.
        const raw = res as unknown;
        const list = Array.isArray(raw)
          ? (raw as PricingTier[])
          : ((raw as { data?: PricingTier[] })?.data ?? []);
        setTiers(list);
      })
      .catch(() => {
        setError(t('credits.dialog.checkout_failed'));
      })
      .finally(() => setLoading(false));
  }, [open, t]);

  const handlePick = async (tier: PricingTier) => {
    if (pendingTier) return;
    setPendingTier(tier.name);
    setError(null);
    try {
      const successUrl = `${window.location.origin}${window.location.pathname}?payment=success`;
      const cancelUrl = `${window.location.origin}${window.location.pathname}?payment=cancel`;
      const res = await paymentApi.createCheckout({
        tier: tier.name,
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      const url = (res as unknown as { data?: { url: string } })?.data?.url;
      if (!url) throw new Error('Missing checkout URL');
      window.location.href = url;
    } catch {
      setError(t('credits.dialog.checkout_failed'));
      setPendingTier(null);
    }
  };

  // CSS-var arbitrary value class names. Defined once here so the
  // JSX below isn't a wall of `text-[var(...)]`.
  const TXT_BASE = 'text-[var(--color-text-default-base)]';
  const TXT_SECONDARY = 'text-[var(--color-text-default-secondary)]';
  const TXT_TERTIARY = 'text-[var(--color-text-default-tertiary)]';
  const TXT_ERROR = 'text-[var(--color-text-status-error)]';
  const BG_BASE = 'bg-[var(--color-background-default-base)]';
  const BG_SECONDARY = 'bg-[var(--color-background-default-secondary)]';
  const BORDER_BASE = 'border-[var(--color-border-default-base)]';

  return (
    <Dialog
      show={open}
      onClose={onClose}
      title={t('credits.dialog.title')}
      width={720}
      bodyClassName="pt-2"
    >
      <div className={cn('flex items-center justify-between rounded-md px-4 py-3 mb-5', BG_SECONDARY)}>
        <div>
          <div className={cn('text-[11px] uppercase tracking-wider mb-1', TXT_SECONDARY)}>
            {t('credits.dialog.balance_label')}
          </div>
          <div className={cn('text-[22px] font-mono font-bold inline-flex items-center gap-1.5', TXT_BASE)}>
            <StarGlyph className="w-3.5 h-3.5 text-brand-base" />
            {balance.toLocaleString()}
          </div>
        </div>
        <div className={cn('text-[11px] font-mono text-right max-w-[40%]', TXT_SECONDARY)}>
          {t('credits.dialog.note')}
        </div>
      </div>

      {loading && (
        <div className={cn('py-12 text-center text-sm', TXT_SECONDARY)}>
          {t('credits.dialog.loading')}
        </div>
      )}

      {!loading && (tiers?.length ?? 0) === 0 && (
        <div className={cn('py-12 text-center text-sm', TXT_SECONDARY)}>
          {error ?? t('credits.dialog.no_tiers')}
        </div>
      )}

      {!loading && tiers && tiers.length > 0 && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
            {tiers.map((tier) => {
              const isPending = pendingTier === tier.name;
              const priceUsd = tier.priceCents / 100;
              const per100 = tier.credits > 0 ? (priceUsd / tier.credits) * 100 : 0;
              const currencyPrefix = tier.currency?.toUpperCase() === 'USD' ? '$' : `${tier.currency?.toUpperCase() ?? ''} `;
              return (
                <button
                  key={tier.name}
                  type="button"
                  disabled={!!pendingTier}
                  onClick={() => handlePick(tier)}
                  className={cn(
                    'relative border rounded-lg p-4 text-center transition-all',
                    BORDER_BASE,
                    BG_BASE,
                    'hover:-translate-y-px hover:shadow-md hover:border-brand-base',
                    pendingTier && !isPending && 'opacity-60 hover:translate-y-0 hover:shadow-none',
                    isPending && 'border-brand-base shadow-md',
                  )}
                >
                  <div className={cn('text-[28px] font-bold font-mono leading-none flex items-baseline justify-center gap-1.5', TXT_BASE)}>
                    <StarGlyph className="w-3.5 h-3.5 text-brand-base self-center" />
                    {tier.credits.toLocaleString()}
                  </div>
                  <div className={cn('text-[11px] font-mono mt-1.5 mb-3.5', TXT_SECONDARY)}>
                    {labelFor(tier.name)}
                  </div>
                  <div className={cn('text-[18px] font-semibold', TXT_BASE)}>
                    {currencyPrefix}{priceUsd.toFixed(2)}
                  </div>
                  <div className={cn('text-[11px] mt-0.5', TXT_TERTIARY)}>
                    {currencyPrefix}{per100.toFixed(2)} {t('credits.dialog.per100_unit')}
                  </div>
                </button>
              );
            })}
          </div>
          {error && (
            <div className={cn('mt-4 text-center text-sm', TXT_ERROR)}>
              {error}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
};

export default RechargeDialog;
