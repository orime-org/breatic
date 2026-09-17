// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What index.css must say about a sticky's prose.
 *
 * `AnnotationBody` writes a scope class on its wrapper and renders six marks
 * into it. Four of those marks carry their own appearance; two do not — a list
 * is a list because of its markers, and a link is a link because it does not
 * look like the words around it — and Tailwind's preflight clears exactly
 * those two. Measured on a board with nothing written here: `ul` and `ol` came
 * back `list-style-type: none` at `padding-left: 0px`, and the anchor took the
 * prose colour with no underline, so half of what A19 promises was invisible.
 *
 * Read as text rather than run, for the same reason the chat prose test is: a
 * colour resolves to the same pixels whether a token or a hex literal put it
 * there.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss from 'postcss';
import { describe, it, expect } from 'vitest';

/** The stylesheet, as text. */
const CSS = readFileSync(
  resolve(__dirname, '../../../../index.css'),
  'utf8',
);

/**
 * Every rule whose selector mentions the sticky prose scope, wherever it sits.
 *
 * Parsed rather than matched: a rule nested in an at-rule paints the same
 * pixels as one at the top level, and a regex over braces reads the two
 * differently.
 * @returns The selector and the declarations of each such rule.
 */
function stickyRules(): { selector: string; body: string }[] {
  const found: { selector: string; body: string }[] = [];
  postcss.parse(CSS).walkRules((rule) => {
    if (!rule.selector.includes('.annotation-body')) return;
    const body = rule.nodes
      .filter((node) => node.type === 'decl')
      .map((decl) => `${decl.prop}: ${decl.value};`)
      .join(' ');
    found.push({ selector: rule.selector, body });
  });
  return found;
}

/**
 * Everything the scope declares for one selector.
 *
 * Every matching rule rather than the first: a property is often split across
 * two — the shared one that indents both list kinds, and the one that gives
 * each its own marker — and reading only the first says the second is missing.
 * @param selector - The full selector to look for.
 * @returns The declarations of every such rule, or undefined when none exists.
 */
function ruleFor(selector: string): string | undefined {
  const bodies = stickyRules()
    .filter((rule) =>
      rule.selector.split(',').some((one) => one.trim() === selector),
    )
    .map((rule) => rule.body);
  return bodies.length === 0 ? undefined : bodies.join(' ');
}

describe('a sticky has a stylesheet at all', () => {
  it('writes rules for the scope its renderer names', () => {
    expect(stickyRules().length).toBeGreaterThan(0);
  });

  it('puts every one of them inside a cascade layer', () => {
    // Layers sort before specificity, so an unlayered rule beats every layered
    // one — and Tailwind's utilities all live in `@layer utilities`. Written
    // unlayered, these would win against any utility a component inside the
    // prose writes on its own element.
    const unlayered: string[] = [];
    postcss.parse(CSS).walkRules((rule) => {
      if (!rule.selector.includes('.annotation-body')) return;
      let node = rule.parent;
      let layered = false;
      while (node !== undefined && node.type !== 'root') {
        if (node.type === 'atrule' && node.name === 'layer') layered = true;
        node = node.parent;
      }
      if (!layered) unlayered.push(rule.selector);
    });
    expect(unlayered).toEqual([]);
  });
});

describe('the two marks preflight takes away', () => {
  it('gives a bulleted list its markers and its indent back', () => {
    const rule = ruleFor('.annotation-body ul');
    expect(rule, 'a bulleted list has no rule').toBeDefined();
    expect(rule).toMatch(/list-style-type:\s*disc/);
  });

  it('gives a numbered list its numbers back', () => {
    const rule = ruleFor('.annotation-body ol');
    expect(rule, 'a numbered list has no rule').toBeDefined();
    expect(rule).toMatch(/list-style-type:\s*decimal/);
  });

  it('indents both kinds so the markers have somewhere to sit', () => {
    const rules = stickyRules().filter((rule) =>
      rule.selector
        .split(',')
        .some((one) => /\.annotation-body (ul|ol)$/.test(one.trim())),
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((rule) => /padding-inline-start:/.test(rule.body))).toBe(
      true,
    );
  });

  it('tells a link apart from the words around it, twice over', () => {
    // Colour and underline both, because colour alone is not allowed to be the
    // only signal (WCAG 1.4.1) and this is the one place the package's
    // neutral-chrome rule makes an exception for.
    const rule = ruleFor('.annotation-body a');
    expect(rule, 'a link has no rule').toBeDefined();
    expect(rule).toMatch(/color:\s*var\(--color-content-link\)/);
    expect(rule).toMatch(/text-decoration:\s*underline/);
  });
});

describe('a line the author broke stays broken', () => {
  it('keeps the newlines a paragraph was typed with', () => {
    // Shift+Enter is offered as "a line inside the note", and markdown folds a
    // single newline into a space. Measured: `first\nsecond` came out as one
    // run of text.
    const scope = ruleFor('.annotation-body');
    expect(scope, 'the scope itself has no rule').toBeDefined();
    expect(scope).toMatch(/white-space:\s*pre-wrap/);
  });

  it('breaks a word too long for 200px rather than widening the note', () => {
    const scope = ruleFor('.annotation-body');
    expect(scope).toMatch(/overflow-wrap:\s*break-word/);
  });
});

describe('the sticky prose keeps to itself', () => {
  it('declares no scroller of its own', () => {
    // Every visible scroller goes through ScrollArea; a raw overflow here
    // would be one the guard cannot see, since it reads TSX.
    for (const rule of stickyRules()) {
      expect(rule.body).not.toMatch(/overflow(-[xy])?:\s*(auto|scroll)/);
    }
  });

  it('spells no colour out', () => {
    for (const rule of stickyRules()) {
      expect(
        rule.body,
        `${rule.selector} spells a colour out`,
      ).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(/i);
    }
  });

  it('touches neither the chat prose nor the document body', () => {
    for (const rule of stickyRules()) {
      expect(rule.selector).not.toContain('.chat-markdown');
      expect(rule.selector).not.toContain('.doc-body');
      expect(rule.selector).not.toContain('.ProseMirror');
    }
  });
});
