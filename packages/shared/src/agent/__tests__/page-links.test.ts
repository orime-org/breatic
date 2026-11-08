// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading links out of text, and the one key two spellings of a page share
 * (inner#1664 design §6.0 "link extraction and comparison").
 *
 * The server builds the set of links the Agent may read from these, and the
 * chat panel merges two sources naming one page by the key. A link the user
 * wrote that the extraction misses is a page the Agent refuses to read; two
 * spellings of one page that get different keys are two source rows for one
 * page. Chinese text appears here because the behaviour under test is how a
 * link ends inside Chinese prose.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { pageLinkKey, pageLinksIn } from "@shared/agent/page-links.js";

describe("pageLinksIn: which links a piece of text holds", () => {
  it("finds http and https links in the order they appear", () => {
    expect(pageLinksIn("see https://example.com/a and then http://b.org/x for more")).toEqual([
      "https://example.com/a",
      "http://b.org/x",
    ]);
  });

  it("finds a host written without a scheme, and returns it as written", () => {
    expect(pageLinksIn("look at github.com/a/b please")).toEqual(["github.com/a/b"]);
    expect(pageLinksIn("the site example.com has it")).toEqual(["example.com"]);
  });

  it("keeps the order of appearance across links with and without a scheme", () => {
    expect(pageLinksIn("first example.com then https://a.org/x then docs.python.org/3/")).toEqual([
      "example.com",
      "https://a.org/x",
      "docs.python.org/3/",
    ]);
  });

  it("does not read the host of a full link a second time as a link without a scheme", () => {
    expect(pageLinksIn("open https://github.com/a/b now")).toEqual(["https://github.com/a/b"]);
  });

  it("does not take a dotted word whose last label is not two or more letters for a host", () => {
    expect(pageLinksIn("version 1.2 of file.c is 3.14 times a.b2 bigger")).toEqual([]);
  });

  it("answers no links for text that holds none", () => {
    expect(pageLinksIn("no links in this sentence")).toEqual([]);
    expect(pageLinksIn("")).toEqual([]);
  });

  it("ends a link at whitespace, including a newline, a tab and an ideographic space", () => {
    expect(pageLinksIn("https://example.com/a\nnext")).toEqual(["https://example.com/a"]);
    expect(pageLinksIn("https://example.com/a\tnext")).toEqual(["https://example.com/a"]);
    expect(pageLinksIn("https://example.com/a　next")).toEqual(["https://example.com/a"]);
  });

  it.each(["，", "。", "、", "；", "：", "！", "？", "）", "》", "」", "』", "】"])(
    "ends a link at the Chinese punctuation mark %s",
    (mark) => {
      expect(pageLinksIn(`链接https://example.com/p${mark}后面的文字`)).toEqual([
        "https://example.com/p",
      ]);
      expect(pageLinksIn(`去 example.com/p${mark}后面的文字`)).toEqual(["example.com/p"]);
    },
  );

  it.each([".", ",", ";", ":", "!", "?"])(
    "drops the English punctuation mark %s that ends a sentence after a link",
    (mark) => {
      expect(pageLinksIn(`Read https://example.com/a/b${mark} Then answer.`)).toEqual([
        "https://example.com/a/b",
      ]);
      expect(pageLinksIn(`Read example.com/a/b${mark}`)).toEqual(["example.com/a/b"]);
    },
  );

  it("drops several trailing English punctuation marks", () => {
    expect(pageLinksIn("Is it https://example.com/a?!...")).toEqual(["https://example.com/a"]);
  });

  it("keeps a closing parenthesis that closes one opened inside the link", () => {
    expect(pageLinksIn("see https://en.wikipedia.org/wiki/Foo_(bar) for it")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("drops a closing parenthesis that closes one opened before the link", () => {
    expect(pageLinksIn("the docs (see https://example.com/a) say so")).toEqual([
      "https://example.com/a",
    ]);
    expect(pageLinksIn("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
    expect(pageLinksIn("(https://example.com/a).")).toEqual(["https://example.com/a"]);
  });

  it("reads the address of a Markdown link", () => {
    expect(pageLinksIn("the [docs](https://example.com/docs) say so")).toEqual([
      "https://example.com/docs",
    ]);
    expect(
      pageLinksIn("[one](https://a.org/1) and [two](https://b.org/wiki/X_(y))"),
    ).toEqual(["https://a.org/1", "https://b.org/wiki/X_(y)"]);
  });

  it("removes the backslashes Markdown escapes write inside a link", () => {
    // turndown writes the parentheses and underscores of a link as \( \) \_.
    expect(pageLinksIn("https://x.org/a\\(b\\) end")).toEqual(["https://x.org/a(b)"]);
    expect(pageLinksIn("https://x.org/snake\\_case end")).toEqual(["https://x.org/snake_case"]);
  });

  it.each(['"', "<", ">", "`", "{", "}", "|", "^"])(
    "ends a link at %s, which RFC 3986 never allows unencoded",
    (mark) => {
      expect(pageLinksIn(`see https://x.example/a${mark}rest of it`)).toEqual(["https://x.example/a"]);
      expect(pageLinksIn(`see x.example/a${mark}rest of it`)).toEqual(["x.example/a"]);
    },
  );

  it("reads a link out of quotes, angle brackets and JSON", () => {
    expect(pageLinksIn('He wrote "https://x.example/a" here')).toEqual(["https://x.example/a"]);
    expect(pageLinksIn("open <https://x.example/a> now")).toEqual(["https://x.example/a"]);
    expect(pageLinksIn('<a href="https://x.example/a">A</a>')).toEqual(["https://x.example/a"]);
    expect(pageLinksIn('{"url":"https://x.example/a","n":1}')).toEqual(["https://x.example/a"]);
  });

  it.each(["(", "_", "*", "#", "!", ".", "-"])(
    "drops the backslash of the Markdown escape \\%s and keeps reading the link",
    (mark) => {
      expect(pageLinksIn(`https://x.org/a\\${mark}b end`)).toEqual([`https://x.org/a${mark}b`]);
    },
  );

  it("drops the backslashes of escaped brackets and keeps reading the link", () => {
    expect(pageLinksIn("https://x.org/a\\[b\\]c end")).toEqual(["https://x.org/a[b]c"]);
    expect(pageLinksIn("https://x.org/a\\(b\\)c end")).toEqual(["https://x.org/a(b)c"]);
  });

  it.each([
    ["a letter, as in a JSON \\n", "https://x.org/a\\nb", "https://x.org/a"],
    ["a quote, as in a JSON \\\"", 'https://x.org/a\\"b', "https://x.org/a"],
    ["a JSON \\t", "https://x.org/a\\tb", "https://x.org/a"],
    ["a JSON \\u escape", "https://x.org/a\\u4e2db", "https://x.org/a"],
    ["another backslash", "https://x.org/a\\\\b", "https://x.org/a"],
    ["a space", "https://x.org/a\\ b", "https://x.org/a"],
    ["a Chinese character", "https://x.org/a\\中文", "https://x.org/a"],
    ["nothing, at the end of the text", "https://x.org/a\\", "https://x.org/a"],
  ])("ends a link at a backslash followed by %s", (_label, text, link) => {
    expect(pageLinksIn(text)).toEqual([link]);
  });

  it("reads a link out of a document body written as JSON, where a newline is a backslash and n", () => {
    const body = JSON.stringify({ type: "paragraph", text: "See https://x.example/spec\nDeadline Friday" });
    expect(body).toContain("spec\\nDeadline");

    expect(pageLinksIn(body)).toEqual(["https://x.example/spec"]);
  });

  it("reads a link out of JSON text that quotes it or follows it with a tab", () => {
    expect(pageLinksIn(JSON.stringify('He wrote "https://x.example/spec" here'))).toEqual([
      "https://x.example/spec",
    ]);
    expect(pageLinksIn(JSON.stringify("https://x.example/spec\tnext"))).toEqual([
      "https://x.example/spec",
    ]);
  });
});

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

/** Words of text around a link, holding no link of their own. */
const proseArb: fc.Arbitrary<string> = fc
  .array(fc.oneof(charsOf("abcdefghijklmnopqrstuvwxyzABC", 1, 8), charsOf(CHINESE, 1, 6)), {
    minLength: 0,
    maxLength: 6,
  })
  .map((words) => words.join(" "));

/** What may follow a link and end it. */
const enderArb: fc.Arbitrary<string> = fc.constantFrom(
  " ",
  "\n",
  "，",
  "。",
  "、",
  "；",
  "：",
  "！",
  "？",
  "）",
  "》",
  "」",
  "』",
  "】",
  ". ",
  ", ",
  "! ",
  "? ",
);

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

  it("reads a link out of surrounding Chinese and English text unchanged, with the key it has alone", () => {
    fc.assert(
      fc.property(
        linkPartsArb,
        fc.nat(),
        proseArb,
        enderArb,
        proseArb,
        (parts, pick, before, ender, after) => {
          const spellings = spellingsOf(parts);
          const link = spellings[pick % spellings.length] as string;
          const text = `${before} ${link}${ender}${after}`;
          const found = pageLinksIn(text);
          expect(found, text).toEqual([link]);
          expect(pageLinkKey(found[0] as string)).toBe(pageLinkKey(link));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("reads a link followed by a newline and words out of the same text written as JSON", () => {
    fc.assert(
      fc.property(linkPartsArb, fc.nat(), proseArb, proseArb, (parts, pick, before, after) => {
        const spellings = spellingsOf(parts);
        const link = spellings[pick % spellings.length] as string;
        const text = JSON.stringify(`${before} ${link}\n${after}`);
        expect(pageLinksIn(text), text).toEqual([link]);
      }),
      { numRuns: 300 },
    );
  });
});
