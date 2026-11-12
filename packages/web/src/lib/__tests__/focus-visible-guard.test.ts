// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Focus rings show only while the user is on the keyboard (#1452).
 *
 * `index.css` rewrites Tailwind's `focus-visible` variant to also require
 * `[data-input-modality=keyboard]` on `<html>`, so every `focus-visible:`,
 * `group-focus-visible:`, `peer-focus-visible:` and `has-focus-visible:` class
 * follows the input modality. These spellings slip past that rewrite and draw a
 * ring after a mouse press: an arbitrary variant that writes `:focus-visible`
 * itself (`has-[:focus-visible]:`); a ring, outline or shadow class on `focus:`
 * or `focus-within:`; a hand-written CSS rule on `:focus`, `:focus-within` or
 * `:focus-visible` without the modality; and a `@custom-variant` that names
 * them without it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import postcss, { type AtRule, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../..');

/** An arbitrary variant, one level of nested brackets allowed, naming `:focus-visible`. */
const ARBITRARY_FOCUS_VISIBLE =
  /\[(?:[^[\]\s]|\[[^[\]\s]*\])*:focus-visible(?:[^[\]\s]|\[[^[\]\s]*\])*\]/g;

/** A variant chain that names focus or focus-within (`focus-visible` is rewritten and gated). */
const FOCUS_VARIANT = /focus(?:-within)?(?![\w-])/;

/** A utility that draws a ring, outline or shadow, arbitrary `box-shadow` / `outline` included. */
const RING_UTILITY = /^!?(?:inset-)?(?:ring|outline|shadow)(?!-(?:0|none|hidden)$)|^!?\[(?:box-shadow|outline)/;

/** Declarations that draw a ring. */
const RING_PROPS = new Set(['outline', 'outline-style', 'outline-width', 'outline-color', 'box-shadow']);

/**
 * Every source file under `src` with one of the extensions, tests excluded.
 * @param exts - File extensions to keep, with the dot.
 * @returns Absolute paths.
 */
function sourceFiles(exts: string[]): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((p) => exts.some((ext) => p.endsWith(ext)))
    .filter((p) => !p.split(/[\\/]/).includes('__tests__'))
    .map((p) => join(SRC, p));
}

/**
 * Splits a class at its last colon outside brackets into its variants and its utility.
 * @param token - One class, e.g. `group-focus/row:after:ring-1`.
 * @returns The variant chain and the utility, or null for a class with no variant.
 */
function splitClass(token: string): [string, string] | null {
  let depth = 0;
  for (let i = token.length - 1; i >= 0; i -= 1) {
    const char = token[i];
    if (char === ']') depth += 1;
    else if (char === '[') depth -= 1;
    else if (char === ':' && depth === 0) return [token.slice(0, i), token.slice(i + 1)];
  }
  return null;
}

/**
 * The classes in a source text that draw a ring whatever the input modality:
 * arbitrary variants writing `:focus-visible` themselves, and any class whose
 * variants name focus or focus-within and whose utility draws a ring, outline
 * or shadow.
 * @param text - TypeScript or TSX source.
 * @returns The offending classes.
 */
function unconditionalRingClasses(text: string): string[] {
  const found: string[] = [...(text.match(ARBITRARY_FOCUS_VISIBLE) ?? [])];
  for (const token of text.split(/[\s'"`]+/)) {
    const parts = splitClass(token);
    if (parts !== null && FOCUS_VARIANT.test(parts[0]) && RING_UTILITY.test(parts[1])) found.push(token);
  }
  return found;
}

/**
 * The rules in a stylesheet that draw a ring on focus whatever the input
 * modality, and the custom variants that name focus without the modality. A
 * rule that only clears (`outline: none`, `box-shadow: none`) is allowed.
 * @param css - Stylesheet text.
 * @returns The offending selectors and variants.
 */
function unconditionalFocusRings(css: string): string[] {
  const found: string[] = [];
  const sheet = postcss.parse(css);
  sheet.walkAtRules('custom-variant', (variant: AtRule) => {
    const text = variant.toString();
    if (text.includes(':focus') && !text.includes('[data-input-modality=keyboard]')) found.push(`@custom-variant ${variant.params}`);
  });
  sheet.walkRules((rule: Rule) => {
    // Each selector of a list on its own; a negated modality gates nothing.
    const ungated = rule.selectors.filter(
      (s) => s.includes(':focus') && (!s.includes('[data-input-modality=keyboard]') || s.includes(':not([data-input-modality=keyboard])')),
    );
    if (ungated.length === 0) return;
    let draws = false;
    rule.walkDecls((decl) => {
      if (RING_PROPS.has(decl.prop) && !/^(none|0(px)?)(\s*!important)?$/.test(decl.value.trim())) draws = true;
    });
    if (draws) found.push(ungated.join(', '));
  });
  return found;
}

describe('the focus-visible checks themselves', () => {
  it('flag arbitrary variants, nested brackets included', () => {
    expect(unconditionalRingClasses('px-2 has-[:focus-visible]:bg-accent')).toHaveLength(1);
    expect(unconditionalRingClasses('has-[>:first-child:focus-visible]:ring-1')).toHaveLength(1);
    expect(unconditionalRingClasses('[&_[role=slider]:focus-visible]:ring-1')).toHaveLength(1);
    expect(unconditionalRingClasses('has-[[data-slot=x]:focus-visible]:bg-accent')).toHaveLength(1);
  });

  it('pass the stacked variants the rewrite already covers', () => {
    expect(unconditionalRingClasses('aria-invalid:focus-visible:border-status-error-foreground')).toEqual([]);
    expect(unconditionalRingClasses('data-[state=open]:focus-visible:ring-1')).toEqual([]);
    expect(unconditionalRingClasses('focus-visible:ring-1 has-focus-visible:opacity-100')).toEqual([]);
  });

  it('flag ring, outline and shadow classes on focus and focus-within, whatever the other variants', () => {
    expect(unconditionalRingClasses('px-2 focus:ring-1 focus:ring-ring')).toHaveLength(2);
    for (const spelling of [
      'focus-within:ring-2',
      'aria-invalid:focus:outline-2',
      'group-focus:shadow-md',
      'focus:after:ring-1',
      'focus-within:after:outline',
      'focus:hover:ring-1',
      'has-focus:ring-1',
      'has-focus-within:ring-1',
      'in-focus:ring-1',
      'group-focus/card:ring-1',
      'focus:!ring-2',
      'focus:inset-ring-1',
      '[&:focus]:ring-1',
      'has-[:focus]:ring-1',
      'focus:[box-shadow:0_0_0_1px_red]',
    ]) {
      expect(unconditionalRingClasses(`px-2 ${spelling}`), spelling).toEqual([spelling]);
    }
  });

  it('pass focus classes that draw no ring, and rings the rewrite already gates', () => {
    expect(
      unconditionalRingClasses(
        'focus:outline-none focus:border-active-border focus:bg-accent focus:ring-0 focus-visible:after:ring-1 has-[.ProseMirror-focused]:border-active-border',
      ),
    ).toEqual([]);
  });

  it('flag a custom variant that names focus without the modality', () => {
    expect(unconditionalFocusRings('@custom-variant x (&:has(:focus-visible));')).toEqual(['@custom-variant x (&:has(:focus-visible))']);
    expect(
      unconditionalFocusRings('@custom-variant x (&:has(:focus-visible):where([data-input-modality=keyboard] *));'),
    ).toEqual([]);
  });

  it('flag a CSS rule that draws a ring without the modality, pass clears and keyboard-only rules', () => {
    expect(unconditionalFocusRings('.a:focus { outline: 2px solid red; }')).toEqual(['.a:focus']);
    expect(
      unconditionalFocusRings('html:not([data-input-modality=keyboard]) .x:focus-visible { outline: 2px solid red; }'),
    ).toEqual(['html:not([data-input-modality=keyboard]) .x:focus-visible']);
    expect(
      unconditionalFocusRings('[data-input-modality=keyboard] .a:focus, .b:focus { outline: 2px solid red; }'),
    ).toEqual(['.b:focus']);
    expect(unconditionalFocusRings('.a:focus-within { box-shadow: 0 0 0 1px red; }')).toEqual(['.a:focus-within']);
    expect(unconditionalFocusRings('.a:focus-visible { outline: 2px solid red; }')).toEqual(['.a:focus-visible']);
    expect(unconditionalFocusRings('.a:focus-visible { box-shadow: 0 0 0 1px red; }')).toEqual(['.a:focus-visible']);
    expect(unconditionalFocusRings('.a:focus-visible { outline: none; box-shadow: none; }')).toEqual([]);
    expect(
      unconditionalFocusRings('[data-input-modality=keyboard] .a:focus-visible { outline: 1px solid red; }'),
    ).toEqual([]);
  });
});

describe('focus rings follow the input modality', () => {
  it('index.css rewrites the focus-visible variant to require keyboard modality', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    expect(css).toContain(
      '@custom-variant focus-visible (&:focus-visible:where([data-input-modality=keyboard] *));',
    );
  });

  it('index.css clears the browser outline outside keyboard modality', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    expect(css).toContain(':where(html:not([data-input-modality=keyboard])) :focus-visible');
  });

  it('no class string draws a ring outside keyboard modality', () => {
    const offenders = sourceFiles(['.ts', '.tsx']).flatMap((file) =>
      unconditionalRingClasses(readFileSync(file, 'utf8')).map((v) => `${relative(SRC, file)}: ${v}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no stylesheet draws a ring on focus without the modality', () => {
    const offenders = sourceFiles(['.css']).flatMap((file) =>
      unconditionalFocusRings(readFileSync(file, 'utf8')).map((s) => `${relative(SRC, file)}: ${s}`),
    );
    expect(offenders).toEqual([]);
  });
});
