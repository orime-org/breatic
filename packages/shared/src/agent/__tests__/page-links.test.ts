// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one key two spellings of a page share (inner#1664 design §6.0 "link
 * extraction and comparison"); reading links out of text is tested beside
 * `pageLinksIn` in `@breatic/domain`.
 *
 * The chat panel merges two sources naming one page by the key, and the
 * server compares a link the model asks for with the ones the conversation
 * holds by it; two spellings of one page that get different keys are two
 * source rows for one page. Chinese text appears here because the behaviour
 * under test is how a Chinese path is keyed.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { pageLinkKey } from "@shared/agent/page-links.js";

describe("pageLinkKey: the key two spellings of a page share", () => {
  it("lower-cases the host and drops the scheme, the fragment and a trailing slash", () => {
    expect(pageLinkKey("https://Example.COM/a/b/#part")).toBe("example.com/a/b");
  });

  it("gives a bare host the host as its key", () => {
    expect(pageLinkKey("https://example.com/")).toBe("example.com");
    expect(pageLinkKey("example.com")).toBe("example.com");
  });

  it("keeps the query", () => {
    expect(pageLinkKey("https://example.com/search?q=1#top")).toBe("example.com/search?q=1");
  });

  it("decodes the path", () => {
    expect(pageLinkKey("https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87")).toBe(
      "zh.wikipedia.org/wiki/中文",
    );
  });

  it("gives http and https one key", () => {
    expect(pageLinkKey("http://example.com/a")).toBe(pageLinkKey("https://example.com/a"));
  });

  it("gives a link with and without its trailing slash one key", () => {
    expect(pageLinkKey("https://example.com/a/")).toBe(pageLinkKey("https://example.com/a"));
  });

  it("gives a link with and without its fragment one key", () => {
    expect(pageLinkKey("https://example.com/a#section-2")).toBe(pageLinkKey("https://example.com/a"));
  });

  it("gives a Chinese path and its percent-encoded spelling one key", () => {
    expect(pageLinkKey("https://zh.wikipedia.org/wiki/中文")).toBe(
      pageLinkKey("https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87"),
    );
  });

  it("gives a link written without its scheme the key of the full link", () => {
    expect(pageLinkKey("github.com/a/b")).toBe(pageLinkKey("https://github.com/a/b"));
  });

  it("gives two different queries two keys", () => {
    expect(pageLinkKey("https://example.com/s?q=1")).not.toBe(pageLinkKey("https://example.com/s?q=2"));
  });

  it("gives two different paths two keys, the path keeping its case", () => {
    expect(pageLinkKey("https://example.com/A")).not.toBe(pageLinkKey("https://example.com/a"));
    expect(pageLinkKey("https://example.com/a")).not.toBe(pageLinkKey("https://example.com/b"));
  });

  it("gives two different hosts two keys", () => {
    expect(pageLinkKey("https://a.example.com/x")).not.toBe(pageLinkKey("https://b.example.com/x"));
  });
});

// ---------------------------------------------------------------------------
// Properties (design §9: every spelling of one link gets one key).

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = `${LOWER}0123456789`;
const PATH_CHARS = `${ALNUM}ABCDEFGHIJKLMNOPQRSTUVWXYZ-_`;
const CHINESE = "中文网页链接资料读取用户内容";

/**
 * A string of `min` to `max` characters drawn from `alphabet`.
 * @param alphabet - The characters to draw from.
 * @param min - Fewest characters.
 * @param max - Most characters.
 * @returns The arbitrary.
 */
function charsOf(alphabet: string, min: number, max: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...alphabet.split("")), { minLength: min, maxLength: max })
    .map((chars) => chars.join(""));
}

/** A host: one to three labels and a top-level label of two to six letters. */
const hostArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(
      fc.tuple(charsOf(LOWER, 1, 1), charsOf(ALNUM, 0, 7)).map(([a, b]) => a + b),
      { minLength: 1, maxLength: 3 },
    ),
    charsOf(LOWER, 2, 6),
  )
  .map(([labels, tld]) => [...labels, tld].join("."));

/**
 * A path segment that ends in a letter, a digit or a Chinese character, so no
 * punctuation rule can apply to its end.
 */
const segmentArb: fc.Arbitrary<string> = fc
  .tuple(
    charsOf(PATH_CHARS + CHINESE, 0, 6),
    fc.oneof(charsOf(ALNUM, 1, 1), charsOf(CHINESE, 1, 1)),
  )
  .map(([body, end]) => body + end);

/** One link's parts. */
interface LinkParts {
  host: string;
  segments: string[];
  query: string;
  fragment: string;
}

const linkPartsArb: fc.Arbitrary<LinkParts> = fc.record({
  host: hostArb,
  segments: fc.array(segmentArb, { minLength: 0, maxLength: 3 }),
  query: fc.option(
    fc.tuple(charsOf(LOWER, 1, 4), charsOf(ALNUM, 1, 4)).map(([k, v]) => `?${k}=${v}`),
    { nil: "" },
  ),
  fragment: charsOf(ALNUM, 1, 8),
});

/**
 * The path of a link, its segments as written or percent-encoded.
 * @param parts - The link's parts.
 * @param encoded - Whether to percent-encode each segment.
 * @returns The path, with a leading slash when it has segments.
 */
function pathOf(parts: LinkParts, encoded: boolean): string {
  return parts.segments
    .map((segment) => `/${encoded ? encodeURIComponent(segment) : segment}`)
    .join("");
}

/**
 * Every way one link may be written: the scheme, the host's case, a trailing
 * slash, a fragment, the path percent-encoded, and no scheme at all.
 * @param parts - The link's parts.
 * @returns The spellings, the first being the plain https one.
 */
function spellingsOf(parts: LinkParts): string[] {
  const path = pathOf(parts, false);
  const encodedPath = pathOf(parts, true);
  const { host, query, fragment } = parts;
  const spellings = [
    `https://${host}${path}${query}`,
    `http://${host}${path}${query}`,
    `https://${host.toUpperCase()}${path}${query}`,
    `https://${host}${path}${query}#${fragment}`,
    `https://${host}${encodedPath}${query}`,
    `http://${host.toUpperCase()}${encodedPath}${query}#${fragment}`,
  ];
  // The design reads a link without a scheme as "host/path"; a query straight
  // after a bare host is left out as unspecified.
  if (parts.segments.length > 0 || query === "") spellings.push(`${host}${path}${query}`);
  // A trailing slash is dropped from the end of the path; with a query after
  // it, where "the end" is depends on parsing, so only links without one
  // carry it here.
  if (query === "") {
    spellings.push(`https://${host}${path}/`, `${host}${path}/`, `https://${host}${encodedPath}/#${fragment}`);
  }
  return spellings;
}

describe("pageLinkKey properties", () => {
  it("gives every spelling of one link the key of its plain https spelling", () => {
    fc.assert(
      fc.property(linkPartsArb, (parts) => {
        const [plain, ...others] = spellingsOf(parts);
        const key = pageLinkKey(plain as string);
        for (const spelling of others) {
          expect(pageLinkKey(spelling), spelling).toBe(key);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("answers the same key for a key, read as a link without its scheme", () => {
    fc.assert(
      fc.property(linkPartsArb, (parts) => {
        fc.pre(parts.segments.length > 0 || parts.query === "");
        const key = pageLinkKey(`https://${parts.host}${pathOf(parts, true)}${parts.query}#${parts.fragment}`);
        expect(pageLinkKey(key)).toBe(key);
      }),
      { numRuns: 300 },
    );
  });
});
