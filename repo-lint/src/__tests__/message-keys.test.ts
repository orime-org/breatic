// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { spelledOutKeys } from "#repo-lint/message-keys";

const FILE = "packages/web/src/a.tsx";

describe("spelledOutKeys", () => {
  it("finds an id written as the whole argument", () => {
    expect(spelledOutKeys('t("server.error.not_found")', FILE)).toEqual([
      { key: "server.error.not_found", line: 1 },
    ]);
  });

  it("reads all three string delimiters", () => {
    // A backtick with nothing interpolated is a literal like any other, and
    // nothing stops one being written: the web package forbids the form by
    // lint, the config governing the server package does not, and the server
    // is where the typo that motivated this shipped.
    const code = ["t('a.one')", 't("a.two")', "t(`a.three`)"].join("\n");
    expect(spelledOutKeys(code, FILE)).toEqual([
      { key: "a.one", line: 1 },
      { key: "a.two", line: 2 },
      { key: "a.three", line: 3 },
    ]);
  });

  it("finds an id with no dot, which is the shape a caller gets wrong", () => {
    // Whether a dotless id is allowed is not this function's question — it
    // reports what the source spells out, and the namespacing check judges
    // the shape. Narrowing here would put that judgement out of reach.
    expect(spelledOutKeys("t('cancel')", FILE)).toEqual([
      { key: "cancel", line: 1 },
    ]);
  });

  it("finds a segment that starts with a digit", () => {
    // `canvas.nodePlaceholder.3d` is in all five catalogs. Written out at a
    // call site it must be seen, or the checks disagree with the catalog
    // about what a key is.
    expect(spelledOutKeys('t("canvas.nodePlaceholder.3d")', FILE)).toEqual([
      { key: "canvas.nodePlaceholder.3d", line: 1 },
    ]);
  });

  it("keeps the params object out of the way", () => {
    expect(spelledOutKeys('t("a.b", { count: 2 })', FILE)).toEqual([
      { key: "a.b", line: 1 },
    ]);
  });

  it("says nothing about an interpolated id", () => {
    expect(spelledOutKeys("t(`a.${kind}`)", FILE)).toEqual([]);
  });

  it("says nothing about a literal glued to something else", () => {
    // `t('canvas.group' + suffix)` writes a PREFIX, not an id. Stopping at
    // the closing quote would hand callers a namespace and let them treat it
    // as a missing message — a finding against a call whose real id is not
    // in the source at all.
    expect(spelledOutKeys("t('canvas.group' + suffix)", FILE)).toEqual([]);
  });

  it("says nothing about an id handed in through a variable", () => {
    // The larger half of the same limit: the id IS written out, in a lookup
    // table, and still cannot be seen — the match needs the literal inside
    // the call. Pinned so the limit is measured behaviour rather than a
    // sentence in a docstring.
    const code = ['const KEYS = { one: "a.missing" };', "t(KEYS[kind])"].join(
      "\n",
    );
    expect(spelledOutKeys(code, FILE)).toEqual([]);
  });

  it("ignores a dotted string that is not asked of the catalog", () => {
    expect(spelledOutKeys('import x from "./some.module.css"', FILE)).toEqual(
      [],
    );
  });

  it("ignores an id that only a comment names", () => {
    // A key named in a comment renders nothing, so reporting it would be a
    // false positive by the calling checks' own terms. Measured: the first
    // repo-wide run of the missing-key check reported two ids from a
    // docstring showing callers how a hook is used.
    const code = ["/**", ' * Usage: t("cart.items") returns the label.', " */", 't("a.b")'].join(
      "\n",
    );
    expect(spelledOutKeys(code, FILE)).toEqual([{ key: "a.b", line: 4 }]);
  });

  it("does not confuse another call whose name ends in t", () => {
    // `format(`, `at(`, `setTimeout(` all end in the letter, and a match
    // that ignored the word boundary would read their arguments as ids.
    const code = [
      "format('a.b')",
      "list.at('a.b')",
      "await setTimeout('a.b')",
    ].join("\n");
    expect(spelledOutKeys(code, FILE)).toEqual([]);
  });
});
