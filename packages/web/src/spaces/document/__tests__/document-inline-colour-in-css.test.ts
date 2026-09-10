// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #905 验收 A6: what a coloured run of text renders as.
 *
 * BlockNote renders an inline colour as `data-style-type` plus `data-value`,
 * and its own stylesheet — imported at the top of `index.css` — carries a rule
 * for each of the nine Notion names it ships, pinned to a hard-coded hex that
 * is the same in both themes. Five of our seven hues share a name with one of
 * those nine, so without a rule of our own five would render as Notion's colour
 * and two — `violet` and `teal`, which it has no name for — would render as
 * nothing at all.
 *
 * Two things decide whether ours wins, and both are asserted here because
 * jsdom lays nothing out and cannot be asked what colour the text came out:
 *
 * - Cascade layer. BlockNote's rules are unlayered, and an unlayered rule beats
 *   every layered one whatever the specificity. Ours have to be unlayered too.
 * - Specificity. Among unlayered rules it decides, so ours carry the editor
 *   scope in front — two classes more than BlockNote's two attributes.
 *
 * What the reader actually sees is A6's browser half.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { COLOUR_HUES } from '@web/spaces/document/document-colour-run';


/** The scope every rule of ours carries, which is what outweighs BlockNote's. */
const SCOPE = '.doc-body-editor .ProseMirror';

/** The stylesheet, read once per case so a rule rename cannot pass unseen. */
function stylesheet(): string {
  return readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf8');
}

/**
 * The declarations of the one rule whose selector ends this way.
 * @param tail - The final part of the selector, verbatim.
 * @returns The body of that rule.
 */
function ruleFor(tail: string): string {
  const sheet = stylesheet();
  const opens = sheet.split(`${tail} {`).length - 1;
  expect(opens, `\`${tail}\` should open exactly one rule in index.css`).toBe(1);
  const body = sheet.slice(sheet.indexOf(`${tail} {`) + tail.length);
  return body.slice(body.indexOf('{') + 1, body.indexOf('}'));
}

/**
 * Whether a selector sits inside an `@layer` block.
 *
 * Counted by braces: an unlayered rule has as many closes as opens before it,
 * one inside a layer has one open too many.
 * @param needle - Any part of the selector.
 * @returns Whether it is layered.
 */
function isLayered(needle: string): boolean {
  const sheet = stylesheet();
  const at = sheet.indexOf(needle);
  // A missing selector would otherwise count the braces of the whole file and
  // answer "unlayered", which is the answer this case wants — so it has to be
  // the case that fails rather than the one that passes.
  expect(at, `\`${needle}\` should appear in index.css`).toBeGreaterThan(-1);
  const before = sheet.slice(0, at);
  const opens = before.split('{').length - 1;
  const closes = before.split('}').length - 1;
  return opens > closes;
}

describe('what an inline text colour renders as', () => {
  it.each(COLOUR_HUES)('paints %s with that palette token', (hue) => {
    const rule = ruleFor(
      `${SCOPE} [data-style-type='textColor'][data-value='${hue}']`,
    );

    expect(rule).toContain(`color: var(--color-palette-${hue})`);
  });

  it.each(COLOUR_HUES)('fills %s with that palette tint', (hue) => {
    const rule = ruleFor(
      `${SCOPE} [data-style-type='backgroundColor'][data-value='${hue}']`,
    );

    // The 14% tint is a token of its own rather than a `color-mix` written out
    // here, so the panel's swatch and the text it produces read one value.
    expect(rule).toContain(
      `background-color: var(--color-palette-${hue}-bg)`,
    );
  });

  it('states no colour in hex, so both themes follow the token', () => {
    // Read as whole rules rather than as lines: a selector and the declaration
    // under it are on different lines, so a per-line search would only ever be
    // looking at selectors, where a hex cannot appear anyway.
    const bodies = stylesheet()
      .split(`${SCOPE} [data-style-type=`)
      .slice(1)
      .map((rest) => rest.slice(rest.indexOf('{') + 1, rest.indexOf('}')));

    expect(bodies).toHaveLength(COLOUR_HUES.length * 2);
    bodies.forEach((body) => {
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
  });

  it('leaves the rules unlayered, where BlockNote sets its own', () => {
    // An unlayered rule beats every layered one, so ours inside a layer would
    // lose to BlockNote's for all five hues whose name it also ships — the text
    // would take Notion's hex and nothing here would say so.
    expect(isLayered('[data-style-type=\'textColor\'][data-value=\'red\']')).toBe(
      false,
    );
  });
});
