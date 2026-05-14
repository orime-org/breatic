/**
 * Recharge / payment flow invariant (critical path).
 *
 * Stripe sandbox flow:
 *   click 充值 package → backend creates Checkout Session → frontend
 *   redirects to session.url → Stripe webhook fires (idempotent CAS
 *   on backend) → balance refresh.
 *
 * M0 SCAFFOLD — fill in M3 (RechargeDialog rewrite milestone).
 * Tests must run against Stripe sandbox (not mocked) — webhook idempotency
 * verified separately on backend side; here we verify the frontend
 * redirect + balance-refresh path.
 */

import { describe, it } from 'vitest';

describe.skip('Recharge flow (M3)', () => {
  it('click package POSTs to /payment/checkout-session and gets session URL', () => {
    // TODO M3: mock fetch, click package, assert request + response handling.
  });

  it('redirect uses session.url verbatim (no client-side URL mutation)', () => {
    // TODO M3: assert window.location.href = response.url exactly.
  });

  it('balance reactively refreshes after redirect-back (?session_id)', () => {
    // TODO M3: simulate redirect-back URL, assert userCenterStore.credits
    //         re-fetches.
  });

  it('idempotent — re-arriving on success URL does not double-deduct', () => {
    // TODO M3: arrive on success URL twice, assert single credits fetch.
    //         (backend CAS guarantees real idempotency; UI just shouldn't
    //         retry the credit lookup pointlessly.)
  });
});
