// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The vendor settings the consent suite builds the web app with, and checks
 * outgoing requests against. Test values only: every request to a vendor is
 * answered inside the browser and never reaches the vendor.
 */

/** An Amplitude project key in the shape the SDK accepts. */
export const TEST_AMPLITUDE_API_KEY = '0123456789abcdef0123456789abcdef';

/** A Google Ads tag id in the shape the Google tag accepts. */
export const TEST_GOOGLE_ADS_TAG_ID = 'AW-000000001';

/** The build variables that switch the analytics code on, with the test values. */
export const VENDOR_BUILD_ENV = {
  VITE_AMPLITUDE_API_KEY: TEST_AMPLITUDE_API_KEY,
  VITE_GOOGLE_ADS_TAG_ID: TEST_GOOGLE_ADS_TAG_ID,
  VITE_GOOGLE_ADS_CONVERSION_LABELS: JSON.stringify({ signup: 'test-signup' }),
  VITE_CONSENT_COOKIE_DOMAIN: '',
} as const;

/** The same variables empty, as a self-hosted copy builds without them. */
export const NO_VENDOR_BUILD_ENV: Record<keyof typeof VENDOR_BUILD_ENV, string> = {
  VITE_AMPLITUDE_API_KEY: '',
  VITE_GOOGLE_ADS_TAG_ID: '',
  VITE_GOOGLE_ADS_CONVERSION_LABELS: '',
  VITE_CONSENT_COOKIE_DOMAIN: '',
};

/** The tag a case carries when it runs against the build without vendors. */
export const NO_VENDORS_TAG = '@no-vendors';
