// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiGet, apiPost } from '@web/data/api/request';

export interface CreditTier {
  id: string;
  credits: number;
  priceUsd: number;
  stripePriceId: string;
}

export interface PaymentRecord {
  id: string;
  tierId: string;
  credits: number;
  amountUsd: number;
  status: 'pending' | 'succeeded' | 'failed';
  createdAt: string;
}

export const paymentApi = {
  tiers() {
    return apiGet<{ tiers: CreditTier[] }>('/payment/tiers');
  },
  checkout(body: { tierId: string }) {
    return apiPost<{ checkoutUrl: string }>('/payment/checkout', body);
  },
  history(params: { page?: number; limit?: number } = {}) {
    return apiGet<{ records: PaymentRecord[] }>('/payment', { params });
  },
  get(id: string) {
    return apiGet<PaymentRecord>(`/payment/${id}`);
  },
};
