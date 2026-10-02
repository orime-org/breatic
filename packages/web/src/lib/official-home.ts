// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Official brand destination for all deployments; the website selects the language. */
export const OFFICIAL_HOME_URL = 'https://breatic.ai/';

/** The Terms of Service, on the official website (#302). */
export const TERMS_URL = new URL('terms/', OFFICIAL_HOME_URL).href;

/** The Privacy Policy, on the official website (#302). */
export const PRIVACY_URL = new URL('privacy/', OFFICIAL_HOME_URL).href;
