// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Naming several things inside one sentence (#2175).
 *
 * The things named are often the same word in every language — format names,
 * file extensions — while the way a list of them is strung together is not:
 * English joins the last two with "and", Chinese with 、and 和. A list built
 * in one language and dropped into a sentence in another reads as a mistake,
 * so the joining happens here, where the reader's language is known.
 */

import { getLocale } from '@breatic/shared';

/**
 * Name several things as one phrase, in the language the reader set.
 * @param items - The things to name, in the order they should read.
 * @returns The phrase, e.g. `mp3 and wav`.
 */
export function formatList(items: readonly string[]): string {
  return new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(items);
}
