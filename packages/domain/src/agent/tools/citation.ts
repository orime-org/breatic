// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What `web_search` and `web_fetch` share about the sources they hand the
 * model (inner#1664): one run of citation numbers per turn, and how a page's
 * publisher is named on the source row.
 */

/** A turn's run of citation numbers. */
export interface CitationNumbers {
  /**
   * Take a block of numbers. One synchronous statement, so calls running in
   * the same step cannot take the same block.
   * @param count - How many numbers to take.
   * @returns The first number of the block; the rest follow it.
   */
  reserve(count: number): number;
}

/**
 * A fresh run, numbering from one.
 * @returns The run.
 * @throws {never} Never.
 */
export function citationNumbers(): CitationNumbers {
  let handedOut = 0;
  return {
    reserve(count: number): number {
      const first = handedOut + 1;
      handedOut += count;
      return first;
    },
  };
}

/**
 * Name the publisher a page belongs to.
 *
 * A source row reading `vitest.dev` names a domain; one reading `Vitest` names
 * whoever wrote the page, which is what a user weighs a claim by. The
 * registrable name is the first label after any `www.`, so `www.vogue.co.uk`
 * is Vogue rather than Co or Uk.
 *
 * An address this cannot parse keeps its own text: the row still has to say
 * something, and what the service sent is the closest thing to a name there
 * is.
 * @param url - The page's address.
 * @returns The publisher's name.
 * @throws {never} Never.
 */
export function publisherOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  const name = host.replace(/^www\./, "").split(".")[0] ?? host;
  if (name === "") return host;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
