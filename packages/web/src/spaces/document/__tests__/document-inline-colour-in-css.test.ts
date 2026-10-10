// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #905 验收 A6: what a coloured run of text renders as.
 *
 * BlockNote renders an inline colour as `data-style-type` plus `data-value`,
 * and its own stylesheet — imported at the top of `index.css` — carries a rule
 * for each of the nine Notion names it ships, each reading a
 * `--bn-colors-highlights-*` custom property. Five of our seven hues share a
 * name with one of those nine, so without a rule of our own five would render
 * as Notion's colour and two — `violet` and `teal`, which it has no name for —
 * would render as nothing at all.
 *
 * What decides it is the cascade layer, which is asserted here because jsdom
 * lays nothing out and cannot be asked what colour the text came out. Its
 * sheet is imported into `@layer base` (`index.css`), and ours sit in
 * `@layer components` with the rest of that scope; Tailwind declares the
 * layers `theme, base, components, utilities`, so a later layer beats an
 * earlier one whatever the specificity and ours clear it.
 *
 * What the reader actually sees is A6's browser half.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss, { type AtRule, type Node as CssNode, type Rule } from 'postcss';
import { describe, it, expect } from 'vitest';

import { COLOUR_HUES } from '@web/spaces/document/document-colour-run';


/** The scope every rule of ours carries, which is what outweighs BlockNote's. */
const SCOPE = '.doc-body';

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
 * The layer a selector's rule sits in, read off its parents.
 * @param needle - Any part of the selector.
 * @returns The layer's name, or null when the rule is unlayered.
 */
function layerOf(needle: string): string | null {
  let found: Rule | undefined;
  postcss.parse(stylesheet()).walkRules((rule) => {
    if (found === undefined && rule.selector.includes(needle)) found = rule;
  });
  // A missing selector would otherwise answer "unlayered", so it has to be the
  // case that fails rather than one that passes.
  expect(found, `\`${needle}\` should appear in index.css`).toBeDefined();
  for (let at: CssNode | undefined = found?.parent; at !== undefined; at = at.parent as CssNode | undefined) {
    if (at.type === 'atrule' && (at as AtRule).name === 'layer') return (at as AtRule).params;
  }
  return null;
}

/**
 * One rule's declarations, in the order they are written.
 * @param rule - What `ruleFor` returned.
 * @returns Each declaration, trimmed, with its semicolon dropped.
 */
function declarationsOf(rule: string): string[] {
  return rule
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

describe('what an inline text colour renders as', () => {
  it.each(COLOUR_HUES)('paints %s with that palette token', (hue) => {
    const rule = ruleFor(
      `${SCOPE} [data-style-type='textColor'][data-value='${hue}']`,
    );

    // Every declaration, in order: `color: var(--color-palette-red)` is a
    // substring of `background-color: var(--color-palette-red-bg)`, so a rule
    // that set the wrong property would read as this one. The hue is handed
    // over as `--doc-run-hue` as well, which is what lets the quoted rules
    // grey a run down without naming any of the seven (#1002).
    expect(declarationsOf(rule)).toEqual([
      `--doc-run-hue: var(--color-palette-${hue})`,
      'color: var(--doc-run-hue)',
    ]);
  });

  it.each(COLOUR_HUES)('fills %s with that palette tint', (hue) => {
    const rule = ruleFor(
      `${SCOPE} [data-style-type='backgroundColor'][data-value='${hue}']`,
    );

    // The 30% tint is a token of its own rather than a `color-mix` written out
    // here, so the panel's swatch and the text it produces read one value.
    // `-highlight` and not `-bg`: the shallower tint stays behind whole
    // shapes, where the shape's own edges say where it starts (#999). The raw
    // hue comes too, for the quoted rules to build a greyed fill from (#1002).
    expect(declarationsOf(rule)).toEqual([
      `--doc-run-hue: var(--color-palette-${hue})`,
      `background-color: var(--color-palette-${hue}-highlight)`,
    ]);
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

  it('puts the rules in the components layer, above the layer BlockNote sets its own in', () => {
    // BlockNote's sheet is imported into `base`; the one layer that beats it
    // and still loses to a utility on the run's own element is `components`.
    expect(layerOf('[data-style-type=\'textColor\'][data-value=\'red\']')).toBe('components');
    expect(stylesheet()).toContain('@import \'@blocknote/react/style.css\' layer(base);');
  });
});
