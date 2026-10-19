// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The `error.reason` a refusal carries when the request itself was malformed:
 * its body failed the route's schema, could not be read, or lacked a header
 * the route requires.
 *
 * A page built before a release sends requests in the shape it was built
 * with, so this refusal from a page whose build differs from the live one
 * means the page is out of date. A refusal of a well-formed request (a message
 * too long, credits short) never carries it, which is what keeps those from
 * being read as an out-of-date page.
 */
export const REQUEST_SHAPE_REASON = "request_shape";
