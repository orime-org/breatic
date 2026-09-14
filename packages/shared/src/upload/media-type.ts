// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one judgement every media type from outside has to pass, in one place.
 *
 * Both halves of an upload read it: the ticket endpoint judges what the browser
 * declares, and the ingest Worker judges what a source URL's response declares.
 * A rule that lives in one of them and not the other is a rule that holds only
 * where somebody remembered it.
 */

/** What a stored object may be: the three kinds the canvas puts on a node. */
const UPLOADABLE = /^(image|video|audio)\//;

/**
 * Reduce a declared media type to the one essence a gate can judge.
 *
 * Cut at a comma as well as a semicolon: a browser honours the LAST parsable
 * value when a header carries commas, so `video/mp4,text/html` is served as
 * HTML — measured in Chromium, scripts in it run. What survives here is what
 * gets signed, what R2 stores, and what a reader is eventually handed, so the
 * value the gate reads has to be the value that decides all three.
 * @param raw - The header or field as it arrived.
 * @returns The essence, lowercased and trimmed; empty when there is none.
 */
export function reduceMediaType(raw: string | null | undefined): string {
  return (raw ?? "").split(/[;,]/)[0]!.trim().toLowerCase();
}

/**
 * Whether a reduced media type is one of the kinds the canvas stores.
 *
 * The slash is part of the family name, so a type that merely starts with the
 * same letters (`images/png`) is not one of them.
 * @param value - A value that has been through {@link reduceMediaType}.
 * @returns True when it is uploadable.
 */
export function isUploadableMediaType(value: string): boolean {
  return UPLOADABLE.test(value);
}
