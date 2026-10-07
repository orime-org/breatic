// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one place a decision link is built.
 *
 * Two channels can hand somebody a way to answer a request — the email and the
 * bell entry — and before this they each assembled their own URL. That is how
 * `/project-invite?token=` ended up living in a route handler, a service and a
 * React component at once, and how the two
 * transfer emails ended up pointing somewhere you could not actually answer
 * from.
 *
 * Building it here means changing the landing route is one edit, not a hunt.
 */

/** The landing page every waiting request is answered on. */
const DECISION_PATH = "/decision";

/**
 * Builds the link that opens a request's landing page.
 * @param origin - Scheme and host of the app, as the caller saw it.
 * @param token - The request's share token.
 * @returns The absolute URL to put in an email or a bell row.
 */
export function decisionLink(origin: string, token: string): string {
  return `${origin}${DECISION_PATH}?token=${token}`;
}
