// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Official brand destination for all deployments; the website selects the language. */
export const OFFICIAL_HOME_URL = 'https://breatic.ai/';

/** The Terms of Service, on the official website (#302). */
export const TERMS_URL = new URL('terms/', OFFICIAL_HOME_URL).href;

/** The Privacy Policy, on the official website (#302). */
export const PRIVACY_URL = new URL('privacy/', OFFICIAL_HOME_URL).href;

/** The user manual, on the official website. */
export const TUTORIALS_URL = new URL('tutorials/', OFFICIAL_HOME_URL).href;

/** The mailbox users write to for help. */
export const SUPPORT_EMAIL = 'support@breatic.ai';
