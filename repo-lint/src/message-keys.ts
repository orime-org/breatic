// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { stripComments } from "#repo-lint/strip-comments";

/**
 * One segment of a message key, as a pattern source the checks build on.
 *
 * The three i18n checks ask different questions — is every catalog message
 * read, is every id a source names answerable, is every id namespaced — but
 * they have to agree on what a key looks like, or one would hunt for a shape
 * the others never recognise.
 *
 * A segment may begin with a digit. It did not until 2026-08-06, and the
 * exclusion had a measurable cost: `canvas.nodePlaceholder.3d` is in all five
 * catalogs and no check could see it, so a plain call naming it counted as no
 * use at all and the dead-key check would have reported a live key for
 * deletion. Nothing had gone wrong only because the one file that reads it
 * builds the id by interpolation, which the dead-key check covers by prefix.
 *
 * Widening it was measured rather than assumed: it adds 259 literals to the
 * dead-key check's evidence set — version numbers, an IP address, a licence
 * id — and changes no key's verdict, because that check matches a catalog key
 * whole and no catalog key looks like any of them.
 */
export const KEY_SEGMENT = String.raw`[a-zA-Z0-9][\w-]*`;

/**
 * A message asked of the catalog by name: `t("a.b.c")`, in any of the three
 * string delimiters.
 *
 * Deliberately says nothing about whether the id is well formed — no dot is
 * required, and a segment may start with anything. Judging the shape belongs
 * to `i18n-keys-namespaced`, and it can only do that if this hands over what
 * the source actually wrote. Narrowing here would put a caller's mistake out
 * of every check's reach, which is exactly the gap this closed.
 *
 * The literal has to BE the argument, which is what the trailing `[),]` says:
 * a `)` closes the call, a `,` starts the params object. Without it,
 * `t('canvas.group' + suffix)` matches as far as the closing quote and the
 * namespace reads as a whole id — a finding against a call whose real id is
 * not in the source at all.
 *
 * That anchor is also where this stops: an id wearing a trailing type
 * assertion (`t("a.b" as const)`) or reached through an optional call
 * (`t?.("a.b")`) is not followed by `)` or `,` and goes unseen. Those are
 * syntax decorations rather than another way of naming a key, and a text scan
 * chasing them has no end; none appears in the tree.
 *
 * A backtick is in the class because a backtick with nothing interpolated is
 * a literal like any other, and nothing stops one being written: the web
 * package forbids the form with a `quotes` lint rule, the root config that
 * governs the server package has no such rule, and the server is where the
 * typo these checks exist for shipped. An interpolated one still cannot
 * match, since the id class admits neither `$` nor `{`.
 */
const MESSAGE_CALL = new RegExp(
  String.raw`\bt\(\s*(['"` + "`" + String.raw`])([\w.-]+)\1\s*[),]`,
  "g",
);

/** One translation call whose id is written out in the source. */
export interface SpelledOutKey {
  /** The id, exactly as the source wrote it. */
  readonly key: string;
  /** 1-based line the call sits on. */
  readonly line: number;
}

/**
 * Every message id a source spells out in full as the whole argument of a
 * translation call.
 *
 * One definition, used by both checks that reason about call sites, because
 * getting this right took three rounds of adversarial review — three
 * delimiters, rejecting a concatenated prefix, discounting comments — and two
 * copies of it would drift apart at the first of those.
 *
 * Comments are stripped here rather than by the callers, so that "a key named
 * in a comment is not a call" is part of what finding a call means. Measured:
 * the first repo-wide run of the missing-key check reported two ids from a
 * docstring showing callers how a hook is used, one of them about a shopping
 * cart this product does not have.
 *
 * WHAT THIS CANNOT SEE, and it is more than one thing. An id the call does
 * not spell out: `t(`a.${kind}`)` has no id in the source at all; `t(roleKey)`
 * does have one, written out in full in a lookup table, but not where the
 * match can reach it; `t('a.b' + suffix)` writes a prefix and glues the rest
 * on. Every one of these is silent. They are not rare — the non-literal calls
 * are all in the web package, where they are how a component picks one of
 * several labels — and closing them needs the id resolved back through a
 * variable, which is a different piece of work.
 * The line comes from the stripped text, which keeps one output line per
 * input line, so it still names the line the reader has to open.
 * @param code The source text, comments included.
 * @param file Repo-relative path, used only to name the file if the comment
 *   stripper fails on it.
 * @returns The ids, in the order they appear, exactly as written.
 */
export function spelledOutKeys(code: string, file: string): SpelledOutKey[] {
  const stripped = stripComments(code, "js", file);
  const found: SpelledOutKey[] = [];
  for (const match of stripped.matchAll(MESSAGE_CALL)) {
    const key = match[2];
    if (key === undefined) continue;
    const before = stripped.slice(0, match.index);
    found.push({ key, line: before.split("\n").length });
  }
  return found;
}
