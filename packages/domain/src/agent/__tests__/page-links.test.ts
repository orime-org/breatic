// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading links out of text (inner#1664 design §6.0 "link extraction and
 * comparison").
 *
 * The server builds the set of links the Agent may read from these. A link
 * the user wrote that the extraction misses is a page the Agent refuses to
 * read. Chinese text appears here because the behaviour under test is how a
 * link ends inside Chinese prose.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { READ_PAGE_MAX_URL_CHARS, pageLinkKey } from "@breatic/shared";

import { pageLinkSpansIn, pageLinksIn } from "@domain/agent/page-links.js";

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

  it.each(["\u201C", "\u201D", "\u2018", "\u2019", "\u2026"])(
    "ends a link at the curly quote or ellipsis %s (plan §9 B)",
    (mark) => {
      expect(pageLinksIn(`链接https://example.com/p${mark}后面的文字`)).toEqual([
        "https://example.com/p",
      ]);
      expect(pageLinksIn(`see example.com/p${mark}more`)).toEqual(["example.com/p"]);
    },
  );

  it("reads a link out of curly quotes", () => {
    expect(pageLinksIn("he said \u201Chttps://example.com/a\u201D twice")).toEqual(["https://example.com/a"]);
    expect(pageLinksIn("\u2018example.com/a\u2019")).toEqual(["example.com/a"]);
  });

  it("also returns a link holding a non-ASCII character cut at that character, right after it (plan §9 B)", () => {
    // A user who writes a link and runs on into Chinese without a space must
    // still have the plain ASCII link in the set; the full spelling stays too,
    // because a Chinese path is a real path.
    expect(pageLinksIn("看https://example.com/a中文页面 then")).toEqual([
      "https://example.com/a中文页面",
      "https://example.com/a",
    ]);
    expect(pageLinksIn("看 example.com/news今天的")).toEqual(["example.com/news今天的", "example.com/news"]);
  });

  it("cleans the end of the cut spelling the same way", () => {
    expect(pageLinksIn("see https://example.com/a.中文")).toEqual([
      "https://example.com/a.中文",
      "https://example.com/a",
    ]);
    const found = pageLinksIn("(see https://example.com/a)中文");
    expect(found).toContain("https://example.com/a");
    expect(found).not.toContain("https://example.com/a)");
  });

  it("returns a link with only ASCII characters once", () => {
    expect(pageLinksIn("see https://example.com/a/b?q=1 now")).toEqual(["https://example.com/a/b?q=1"]);
  });

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

  it("reads a parenthesised link back from the Markdown the page reader writes", () => {
    // The exact turndown output pinned by the ingest web-reader to-markdown test.
    expect(pageLinksIn("See [fish](https://en.wikipedia.org/wiki/Fish_\\(food\\)).")).toEqual([
      "https://en.wikipedia.org/wiki/Fish_(food)",
    ]);
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

describe("pageLinksIn: links longer than a page address may be", () => {
  it("drops a link longer than READ_PAGE_MAX_URL_CHARS entirely", () => {
    const long = `https://a.com/${"x".repeat(3000)}`;
    expect(long.length).toBeGreaterThan(READ_PAGE_MAX_URL_CHARS);

    expect(pageLinksIn(`see ${long} now`)).toEqual([]);
  });

  it("keeps a link exactly READ_PAGE_MAX_URL_CHARS long", () => {
    const prefix = "https://a.com/";
    const link = `${prefix}${"x".repeat(READ_PAGE_MAX_URL_CHARS - prefix.length)}`;
    expect(link.length).toBe(READ_PAGE_MAX_URL_CHARS);

    expect(pageLinksIn(`see ${link} now`)).toEqual([link]);
  });

  it("judges the length after the end is trimmed: a run of 20000 closing parentheses keeps its one balanced pair", () => {
    const text = `https://a.com/(${")".repeat(20000)}`;
    const started = performance.now();
    const found = pageLinksIn(text);
    const elapsed = performance.now() - started;

    expect(found).toEqual(["https://a.com/()"]);
    expect(elapsed).toBeLessThan(200);
  });

  describe("a link of exactly READ_PAGE_MAX_URL_CHARS once the sentence's punctuation is trimmed", () => {
    const link = `https://a.com/${"x".repeat(2034)}`;

    it.each([
      ["followed by a full stop", `see ${link}. ok`],
      ["followed by a comma", `see ${link}, ok`],
      ["wrapped in parentheses", `see (${link}) ok`],
    ])("is kept when %s", (_label, text) => {
      expect(link.length).toBe(READ_PAGE_MAX_URL_CHARS);

      const found = pageLinksIn(text);

      expect(found).toEqual([link]);
      expect(found[0]).toHaveLength(READ_PAGE_MAX_URL_CHARS);
    });
  });

  it("judges a link written without a scheme by its length with https:// in front", () => {
    const written = `a.com/${"x".repeat(2042)}`;
    expect(written.length).toBe(READ_PAGE_MAX_URL_CHARS);
    expect(`https://${written}`.length).toBe(READ_PAGE_MAX_URL_CHARS + 8);

    expect(pageLinksIn(`see ${written} now`)).toEqual([]);
  });

  it("keeps a link written without a scheme that is exactly READ_PAGE_MAX_URL_CHARS with https:// in front", () => {
    const written = `a.com/${"x".repeat(2034)}`;
    expect(`https://${written}`.length).toBe(READ_PAGE_MAX_URL_CHARS);

    expect(pageLinksIn(`see ${written} now`)).toEqual([written]);
  });

  it("drops an over-long link as one whole run, never reading a host inside it as a link of its own", () => {
    const text = `https://a.com/?q=${"y".repeat(2100)}&u=evil.com/steal`;

    expect(pageLinksIn(`see ${text} now`)).toEqual([]);
  });

  it("trims the closing parentheses of links within the cap in linear time, keeping each one balanced pair", () => {
    // Each link is 2015 characters. A trim that re-counts the parentheses for
    // every one it drops took about 9 s on this text; a linear one about 10 ms.
    const link = `https://a.com/(${")".repeat(2000)}`;
    expect(link.length).toBeLessThan(READ_PAGE_MAX_URL_CHARS);
    const text = Array.from({ length: 500 }, () => link).join(" ");
    const started = performance.now();
    const found = pageLinksIn(text);
    const elapsed = performance.now() - started;

    expect(found).toEqual(Array.from({ length: 500 }, () => "https://a.com/()"));
    expect(elapsed).toBeLessThan(300);
  });
});

describe("pageLinksIn: Markdown escapes inside a JSON-encoded body", () => {
  it("reads a Markdown-escaped parenthesis that JSON encoding doubled the backslash of", () => {
    // A document body reaches the model JSON-encoded, so turndown's `\(`
    // arrives as two backslashes and then `(`.
    const text = JSON.stringify("see https://en.wikipedia.org/wiki/Mercury_\\(planet\\) now");
    expect(text).toContain("Mercury_\\\\(planet\\\\)");

    const found = pageLinksIn(text);
    expect(found).toEqual(["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
    expect(found).not.toContain("https://en.wikipedia.org/wiki/Mercury_");
    expect(found).not.toContain("https://en.wikipedia.org/wiki/Mercury");
  });
});

describe("pageLinksIn: hosts written without a scheme, and quotes", () => {
  it("reads a host that follows a colon with no space, after Chinese or English", () => {
    expect(pageLinksIn("官网:example.com/pricing")).toEqual(["example.com/pricing"]);
    expect(pageLinksIn("see:example.com/pricing")).toEqual(["example.com/pricing"]);
  });

  it("keeps reading a host followed by a port and a path", () => {
    expect(pageLinksIn("open example.com:8080/docs now")).toEqual(["example.com:8080/docs"]);
  });

  it("keeps reading a host followed by a query", () => {
    expect(pageLinksIn("open example.com?id=42 now")).toEqual(["example.com?id=42"]);
  });

  it("keeps reading a host followed by a fragment", () => {
    expect(pageLinksIn("open example.com#pricing now")).toEqual(["example.com#pricing"]);
  });

  it("ends a host at a colon that is not followed by a port", () => {
    expect(pageLinksIn("the site example.com: it has it")).toEqual(["example.com"]);
  });

  it("drops a trailing single quote the link holds no match for", () => {
    expect(pageLinksIn("'https://example.com/a'")).toEqual(["https://example.com/a"]);
    expect(pageLinksIn("'example.com/a'")).toEqual(["example.com/a"]);
  });

  it("keeps a single quote inside the link when none ends it", () => {
    expect(pageLinksIn("see https://example.com/it's/page now")).toEqual(["https://example.com/it's/page"]);
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

/**
 * What `pageLinksIn` answers for one link alone: the link, then, when it holds
 * a non-ASCII character, the link cut at that character with its end cleaned
 * (plan §9 B).
 * @param link - The link.
 * @returns The links expected.
 */
function expectedFor(link: string): string[] {
  const at = link.search(/[\u0080-\u{10FFFF}]/u);
  if (at < 0) return [link];
  let cut = link.slice(0, at);
  for (;;) {
    const last = cut.at(-1);
    if (last !== undefined && ".,;:!?*_~".includes(last)) cut = cut.slice(0, -1);
    else if (last === ")" && cut.split(")").length > cut.split("(").length) cut = cut.slice(0, -1);
    else break;
  }
  return [link, cut];
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
  "\u201D",
  "\u2019",
  "\u2026",
  ". ",
  ", ",
  "! ",
  "? ",
);

describe("pageLinksIn properties", () => {
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
          expect(found, text).toEqual(expectedFor(link));
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
        expect(pageLinksIn(text), text).toEqual(expectedFor(link));
      }),
      { numRuns: 300 },
    );
  });
});

// Plan §16 rows 1 and 2: where each link sits in the text it was read from,
// so a slice of page text can be cut outside every link. `start` and `end`
// are positions in the text as written: a Markdown escape's backslash is part
// of the link there, and what `trimEnd` drops is not.
describe("pageLinkSpansIn: where each link sits in the text", () => {
  it("gives a plain link's position in the text", () => {
    const text = "see https://a.test/x now";

    expect(pageLinkSpansIn(text)).toEqual([{ link: "https://a.test/x", start: 4, end: 20 }]);
    expect(text.slice(4, 20)).toBe("https://a.test/x");
  });

  it("gives a host written without a scheme its position", () => {
    expect(pageLinkSpansIn("see example.com/x ok")).toEqual([{ link: "example.com/x", start: 4, end: 17 }]);
  });

  it("ends a Markdown-escaped link after the escaped character, backslash included", () => {
    const written = "https://a.test/a\\_b";
    const text = `go ${written} now`;

    const [span] = pageLinkSpansIn(text);

    expect(span).toEqual({ link: "https://a.test/a_b", start: 3, end: 3 + written.length });
    expect(text.slice(span!.start, span!.end)).toBe(written);
  });

  it("ends an escape whose backslash JSON doubled after the escaped character", () => {
    const written = "https://a.test/a\\\\_b";
    const text = `go ${written} now`;

    expect(pageLinkSpansIn(text)).toEqual([{ link: "https://a.test/a_b", start: 3, end: 3 + written.length }]);
  });

  it("leaves the punctuation trimEnd drops outside the link", () => {
    expect(pageLinkSpansIn("see https://a.test/x. Then")).toEqual([{ link: "https://a.test/x", start: 4, end: 20 }]);
    expect(pageLinkSpansIn("(https://a.test/x)")).toEqual([{ link: "https://a.test/x", start: 1, end: 17 }]);
  });

  it("ends a link before an escaped character trimEnd drops, and before its backslash", () => {
    const text = "go https://a.test/a\\_ now";

    expect(pageLinkSpansIn(text)).toEqual([{ link: "https://a.test/a", start: 3, end: 3 + "https://a.test/a".length }]);
  });

  it("ends the spelling cut at a non-ASCII character before that character", () => {
    const text = "\u770bhttps://a.test/a\u4e2d\u6587 then";

    expect(pageLinkSpansIn(text)).toEqual([
      { link: "https://a.test/a\u4e2d\u6587", start: 1, end: 1 + "https://a.test/a".length + 2 },
      { link: "https://a.test/a", start: 1, end: 1 + "https://a.test/a".length },
    ]);
  });

  it("gives each of two writings of one link its own position", () => {
    const text = '{"url":"https://a.test/p/abc","self":"https://a.test/p/abc"}';
    const second = text.lastIndexOf("https");

    expect(pageLinkSpansIn(text)).toEqual([
      { link: "https://a.test/p/abc", start: text.indexOf("https"), end: text.indexOf("https") + 20 },
      { link: "https://a.test/p/abc", start: second, end: second + 20 },
    ]);
  });

  it.each([
  "",
  "'example.com/a'",
  "'https://example.com/a'",
  "(https://en.wikipedia.org/wiki/Foo_(bar))",
  "(https://example.com/a).",
  "(see https://example.com/a)中文",
  "Is it https://example.com/a?!...",
  "See [fish](https://en.wikipedia.org/wiki/Fish_\\(food\\)).",
  "[one](https://a.org/1) and [two](https://b.org/wiki/X_(y))",
  "\u2018example.com/a\u2019",
  "first example.com then https://a.org/x then docs.python.org/3/",
  "he said \u201Chttps://example.com/a\u201D twice",
  "https://example.com/a\nnext",
  "https://example.com/a\tnext",
  "https://example.com/a　next",
  "https://x.org/a\\(b\\) end",
  "https://x.org/a\\(b\\)c end",
  "https://x.org/a\\[b\\]c end",
  "https://x.org/snake\\_case end",
  "look at github.com/a/b please",
  "no links in this sentence",
  "open <https://x.example/a> now",
  "open example.com#pricing now",
  "open example.com:8080/docs now",
  "open example.com?id=42 now",
  "open https://github.com/a/b now",
  "see https://en.wikipedia.org/wiki/Foo_(bar) for it",
  "see https://example.com/a and then http://b.org/x for more",
  "see https://example.com/a.中文",
  "see https://example.com/a/b?q=1 now",
  "see https://example.com/it's/page now",
  "see:example.com/pricing",
  "the [docs](https://example.com/docs) say so",
  "the docs (see https://example.com/a) say so",
  "the site example.com has it",
  "the site example.com: it has it",
  "version 1.2 of file.c is 3.14 times a.b2 bigger",
  "官网:example.com/pricing",
  "看 example.com/news今天的",
  "看https://example.com/a中文页面 then",
  '<a href="https://x.example/a">A</a>',
  'He wrote "https://x.example/a" here',
  '{"url":"https://x.example/a","n":1}',
  ])("reads the same links as pageLinksIn from %j", (text) => {
    expect(pageLinkSpansIn(text).map((span) => span.link)).toEqual(pageLinksIn(text));
  });

  it("reads the same links as pageLinksIn, each span inside the text and in order, for any text", () => {
    fc.assert(
      fc.property(linkPartsArb, fc.nat(), proseArb, enderArb, proseArb, (parts, pick, before, ender, after) => {
        const spellings = spellingsOf(parts);
        const text = `${before} ${spellings[pick % spellings.length] as string}${ender}${after}`;

        const spans = pageLinkSpansIn(text);

        expect(spans.map((span) => span.link)).toEqual(pageLinksIn(text));
        for (const span of spans) {
          expect(0 <= span.start && span.start < span.end && span.end <= text.length, JSON.stringify(span)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
