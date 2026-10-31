// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The `error.reason` a refusal carries when the request itself was malformed:
 * its structure failed the route's schema (a field missing or of another
 * type, an unknown key or enum value, or a refine marked
 * `REQUEST_SHAPE_PARAMS`; a value outside its limits does not count), its
 * body could not be read, or it lacked a header the route requires.
 *
 * A page built before a release sends requests in the shape it was built
 * with, so this refusal from a page whose build differs from the live one
 * means the page is out of date. A refusal of a well-formed request (a message
 * too long, credits short) never carries it, which is what keeps those from
 * being read as an out-of-date page.
 */
export const REQUEST_SHAPE_REASON = "request_shape";

/**
 * The `params` of a schema refine that checks the request's structure rather
 * than a value: which fields a kind of thing must carry. zod reports every
 * refine as a `custom` issue, the same code a value rule produces, so these
 * say which of them a page built before a release would trip.
 */
export const REQUEST_SHAPE_PARAMS = { requestShape: true } as const;
