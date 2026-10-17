// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The campaign source a visitor arrived from (inner#1442 design §4.5): the
 * first touch is kept, the latest follows each new campaign, and both go to
 * the API with a sign-up. Written only while a consent category is accepted.
 */

import { parseAttribution, type Attribution, type AttributionTouch } from '@breatic/shared';
import { STORAGE_KEYS } from '@web/lib/storage-keys';

const CAMPAIGN_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'gbraid',
  'wbraid',
] as const;

/**
 * The touch the current page represents.
 * @param location - The page address.
 * @param referrer - `document.referrer`.
 * @param now - The current time, ISO.
 * @returns The touch, or null for a visit from inside the site with no campaign.
 */
export function touchFrom(location: URL, referrer: string, now: string): AttributionTouch | null {
  const fields: Record<string, string> = {};
  for (const name of CAMPAIGN_PARAMS) {
    const value = location.searchParams.get(name);
    if (value) fields[name] = value;
  }
  let external = '';
  try {
    const from = new URL(referrer);
    if (from.hostname !== location.hostname) external = from.origin + from.pathname;
  } catch {
    // No referrer, or not an address.
  }
  if (Object.keys(fields).length === 0 && external === '') return null;
  return { ...fields, ...(external !== '' ? { referrer: external } : {}), landing_page: location.pathname, at: now };
}

/**
 * Fold a new touch into what is stored.
 * @param stored - The stored attribution.
 * @param touch - The current page's touch.
 * @returns The attribution to keep.
 */
export function mergeTouch(stored: Attribution | null, touch: AttributionTouch): Attribution {
  if (stored === null) return { first: touch, last: touch };
  const isCampaign = CAMPAIGN_PARAMS.some((name) => touch[name] !== undefined);
  return isCampaign ? { first: stored.first, last: touch } : stored;
}

/**
 * Read what this browser kept.
 * @returns The attribution, or null.
 */
export function readAttribution(): Attribution | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.attribution);
    return raw === null ? null : parseAttribution(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Record the landing's source; called once a consent category is accepted.
 * @param landing - The address the visitor arrived on.
 * @param referrer - `document.referrer` at arrival.
 */
export function captureAttribution(landing: URL, referrer: string): void {
  const touch = touchFrom(landing, referrer, new Date().toISOString());
  if (touch === null) return;
  try {
    localStorage.setItem(STORAGE_KEYS.attribution, JSON.stringify(mergeTouch(readAttribution(), touch)));
  } catch {
    // Storage unavailable (private mode, quota): the visit goes unattributed.
  }
}

/** Forget the source; called when every consent category is withdrawn. */
export function clearAttribution(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.attribution);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}
