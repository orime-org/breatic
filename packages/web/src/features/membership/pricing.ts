// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where an account goes to negotiate terms we do not put on a price list.
 *
 * The monthly prices used to live here too, with a note saying they would move
 * once the checkout work needed a price the payment provider agrees with.
 * That work is #106: they are in `config/subscription.yaml`, the same file
 * that names the Stripe price selling each tier, and they reach the panel
 * through `TierOffer`. A second copy here could only ever disagree with what
 * a card is actually charged.
 */
export const SALES_EMAIL = 'breatic@orime.ai';
