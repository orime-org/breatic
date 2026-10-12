// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Product analytics settings baked in at build time (inner#1442 design
 * §4.3). All empty on a self-hosted build, which then ships none of the
 * analytics code: the checks below fold to constants and Vite drops the
 * dynamic import behind them.
 */

/** Amplitude project key; empty turns browser analytics off. */
export const AMPLITUDE_API_KEY: string = (import.meta.env.VITE_AMPLITUDE_API_KEY ?? '').trim();

/** Google tag id (`AW-…`); empty turns ad measurement off. */
export const GOOGLE_ADS_TAG_ID: string = (import.meta.env.VITE_GOOGLE_ADS_TAG_ID ?? '').trim();

/** JSON object: conversion name to Google Ads conversion label. */
const RAW_CONVERSION_LABELS: string = (import.meta.env.VITE_GOOGLE_ADS_CONVERSION_LABELS ?? '').trim();

/** Parent domain the consent cookie is written on; empty means the current host. */
export const CONSENT_COOKIE_DOMAIN: string = (import.meta.env.VITE_CONSENT_COOKIE_DOMAIN ?? '').trim();

/** Injected by `vite.config.mts`; absent under the test runner. */
declare const __ANALYTICS_CONFIGURED__: boolean;

/**
 * Whether any vendor is configured; the banner appears only then. A build
 * constant, so Vite drops everything behind it when it is false.
 */
export const ANALYTICS_CONFIGURED: boolean =
  typeof __ANALYTICS_CONFIGURED__ === 'boolean' && __ANALYTICS_CONFIGURED__;

/**
 * The conversion labels, read leniently: a malformed value disables the
 * browser conversions and leaves everything else working.
 * @returns Conversion name to label.
 */
export function conversionLabels(): Record<string, string> {
  if (RAW_CONVERSION_LABELS === '') return {};
  try {
    const parsed: unknown = JSON.parse(RAW_CONVERSION_LABELS);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}
