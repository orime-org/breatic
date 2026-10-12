// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a page does with consent when it loads (inner#1442 design §4.4.2,
 * §4.4.4), kept apart from the banner library so the rules can be tested.
 */

import { httpRequest, type ConsentSource } from '@breatic/shared';

/** This browser's choice, as the consent cookie holds it. */
export interface BrowserChoice {
  readonly analytics: boolean;
  readonly ads: boolean;
  readonly source: ConsentSource;
  /** When the choice was made, as an ISO timestamp. */
  readonly decidedAt: string;
}

/** What to do on load. */
export interface LoadDecision {
  /** The choice in force; null while an opt-in visitor has not answered. */
  readonly choice: BrowserChoice | null;
  /** Whether `choice` differs from what is stored and has to be written. */
  readonly write: boolean;
  readonly showBanner: boolean;
}

/**
 * Decide on load.
 * @param input - What the page knows.
 * @param input.stored - The stored choice under the current policy, if any.
 * @param input.optIn - Whether the visitor's region asks before anything loads.
 * @param input.gpc - Whether the browser sends Global Privacy Control.
 * @param input.now - The current time, ISO.
 * @returns The choice in force and whether to write it or show the banner.
 */
export function decideOnLoad(input: {
  stored: BrowserChoice | null;
  optIn: boolean;
  gpc: boolean;
  now: string;
}): LoadDecision {
  const { stored, optIn, gpc, now } = input;
  if (stored) {
    // GPC withdraws ads that were only on by default; a choice the visitor made stands.
    if (gpc && stored.ads && stored.source === 'implicit') {
      return { choice: { ...stored, ads: false, source: 'gpc', decidedAt: now }, write: true, showBanner: false };
    }
    return { choice: stored, write: false, showBanner: false };
  }
  if (optIn) return { choice: null, write: false, showBanner: true };
  return {
    choice: { analytics: true, ads: !gpc, source: gpc ? 'gpc' : 'implicit', decidedAt: now },
    write: true,
    showBanner: false,
  };
}

/**
 * The country Cloudflare reports for this visitor.
 * @param trace - The body of `/cdn-cgi/trace`.
 * @returns The two-letter code, or null when the body has none.
 */
export function countryFromTrace(trace: string): string | null {
  return /^loc=([A-Z0-9]{2})$/m.exec(trace)?.[1] ?? null;
}

/** How long the region lookup may take before the visitor is asked first. */
const TRACE_TIMEOUT_MS = 1000;

/**
 * Look the visitor's country up at the same-origin Cloudflare trace endpoint.
 * @param origin - The page's origin.
 * @param request - `httpRequest`, replaced in tests.
 * @param timeoutMs - The limit for the whole lookup, retries included.
 * @returns The country, or null when the lookup fails, errs or is slow; a
 *   self-hosted instance without Cloudflare lands here and asks first.
 */
export async function fetchCountry(
  origin: string,
  request: typeof httpRequest = httpRequest,
  timeoutMs: number = TRACE_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(
      new URL('/cdn-cgi/trace', origin).href,
      { credentials: 'omit' },
      { replaySafe: true, timeoutMs, signal: controller.signal },
    );
    return response.ok ? countryFromTrace(await response.text()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
