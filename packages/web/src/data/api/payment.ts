/**
 * Payment API — pricing tiers, Stripe checkout, transaction history.
 */

import { request, type CustomAxiosRequestConfig } from '@/data/api/request';
import type { PaymentEntity, ApiResponse, PaginatedResponse, CheckoutInput } from '@breatic/shared';

/**
 * Pricing tier from the backend `GET /payment/tiers` response.
 *
 * Sourced from `config/pricing.yaml` (5 tiers in V1). The endpoint
 * returns a bare array (NOT wrapped in `ApiResponse<...>`); the type
 * below mirrors the actual JSON shape.
 */
export interface PricingTier {
  /** Tier identifier — used as the `tier` field on `POST /payment/checkout`. */
  name: string;
  /** Credits granted on successful payment. */
  credits: number;
  /** Price in the smallest currency unit (cents for USD). Display
   *  with `priceCents / 100` for the dollar amount. */
  priceCents: number;
  /** ISO 4217, lowercased — typically `"usd"`. */
  currency: string;
  /** Pre-rendered marketing description from the config. */
  description: string;
}

/**
 * Get available pricing tiers.
 *
 * Returns a bare `PricingTier[]` (no `ApiResponse` envelope) — this
 * endpoint pre-dates the envelope convention. Caller should treat
 * the response as the array directly.
 */
export const getTiers = () =>
  request<PricingTier[]>({
    url: '/api/v1/payment/tiers',
    method: 'get',
  });

/** Create a Stripe Checkout session. */
export const createCheckout = (data: CheckoutInput) =>
  request<ApiResponse<{ url: string }>>({
    url: '/api/v1/payment/checkout',
    method: 'post',
    data,
    needGlobalLoading: true,
  } as CustomAxiosRequestConfig);

/** Get payment history for the current user. */
export const getHistory = (params: { limit?: number; offset?: number } = {}) =>
  request<PaginatedResponse<PaymentEntity>>({
    url: '/api/v1/payment/history',
    method: 'get',
    params,
  });

/** Get a single payment by ID. */
export const getPayment = (id: string) =>
  request<ApiResponse<PaymentEntity>>({
    url: `/api/v1/payment/${id}`,
    method: 'get',
  });
