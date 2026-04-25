/**
 * Payment API — pricing tiers, Stripe checkout, transaction history.
 */

import { request, type CustomAxiosRequestConfig } from '@/utils/request';
import type { PaymentEntity, ApiResponse, PaginatedResponse, CheckoutInput } from '@breatic/shared';

/** Pricing tier from the backend. */
export interface PricingTier {
  name: string;
  credits: number;
  price_usd: number;
  stripe_price_id: string;
}

/** Get available pricing tiers. */
export const getTiers = () =>
  request<ApiResponse<PricingTier[]>>({
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
