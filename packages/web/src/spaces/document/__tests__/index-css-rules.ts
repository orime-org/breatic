// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading `index.css` the way the browser resolves it, for the cases that ask
 * what the stylesheet says rather than what a page looks like.
 *
 * A rule that names our tokens, and arithmetic that has to come out to one
 * number across several declarations, are both answerable from the file. A
 * browser would give the same answer and cost a run of the smoke suite.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The stylesheet, as it ships. */
const css = readFileSync(
  resolve(import.meta.dirname, '../../../index.css'),
  'utf8',
  // Comments out: a rule commented out still matches the selector search
  // below, so a case would read a rule the browser never sees.
).replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The body of the one rule whose selector ends in the given text.
 * @param endsWith - The tail of the selector.
 * @returns That rule's declarations.
 * @throws {Error} When no rule, or more than one, matches.
 */
export function ruleBody(endsWith: string): string {
  const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((match) =>
    match[1].trim().endsWith(endsWith),
  );
  if (found.length !== 1) {
    throw new Error(`${String(found.length)} rules end in ${endsWith}`);
  }
  return found[0][2];
}

/**
 * One length declared in a rule.
 * @param body - The rule's declarations.
 * @param property - Which one to read.
 * @returns Its value in pixels.
 * @throws {Error} When the rule does not declare it in pixels.
 */
export function px(body: string, property: string): number {
  // A zero length carries no unit in CSS, so the suffix is optional.
  const found = new RegExp(`${property}:\\s*(-?[\\d.]+)(px)?[;\\s]`).exec(body);
  if (found === null) {
    throw new Error(`no ${property} in px`);
  }
  return Number(found[1]);
}
