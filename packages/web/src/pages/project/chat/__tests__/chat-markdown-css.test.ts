// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What index.css must say about assistant prose.
 *
 * Read as text rather than run: these are claims about which rules exist and
 * what they are written in terms of, which a rendered page cannot answer —
 * a colour resolves to the same pixels whether it came from a token or from a
 * hex literal pasted in.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss from 'postcss';
import { describe, it, expect } from 'vitest';

/**
 * Reads one file next to index.css.
 * @param name - Its path, relative to the stylesheet.
 * @returns The file's text.
 */
function read(name: string): string {
  return readFileSync(resolve(__dirname, '../../../../', name), 'utf8');
}

/**
 * Every rule whose selector mentions the chat prose scope, wherever it sits.
 *
 * Parsed rather than matched: a rule nested in an at-rule paints the same
 * pixels as one at the top level, and a regex over braces reads the two
 * differently.
 * @returns The selector and the declarations of each such rule.
 */
function chatRules(): { selector: string; body: string }[] {
  const found: { selector: string; body: string }[] = [];
  postcss.parse(read('index.css')).walkRules((rule) => {
    if (!rule.selector.includes('.chat-markdown')) return;
    const body = rule.nodes
      .filter((node) => node.type === 'decl')
      .map((decl) => `${decl.prop}: ${decl.value};`)
      .join(' ');
    found.push({ selector: rule.selector, body });
  });
  return found;
}

/**
 * Every colour name the theme actually declares.
 *
 * A name shaped like a token but spelt wrong resolves to nothing, and the
 * text it was meant to paint takes the surrounding colour instead.
 * @returns Every declared `--color-*` name.
 */
function colourTokens(): Set<string> {
  const names = new Set<string>();
  postcss.parse(read('theme/tokens.css')).walkDecls((decl) => {
    if (decl.prop.startsWith('--color-')) names.add(decl.prop);
  });
  return names;
}

describe('chat prose stylesheet — colours come from tokens (R10)', () => {
  it('draws every colour it declares from a name the theme defines', () => {
    // Every rule in the scope, not only the highlight ones: the link, the
    // strikethrough, the blockquote and the task mark each name a colour too,
    // and a raw hex or a misspelt token in any of them is the same defect.
    const allowed = colourTokens();
    expect(allowed.size).toBeGreaterThan(20);

    const rules = chatRules();
    expect(rules.length).toBeGreaterThan(0);

    let declared = 0;
    for (const rule of rules) {
      // The last declaration in a block may carry no semicolon, so the
      // terminator is optional here; requiring it hid whatever was written
      // last in each rule.
      for (const [, value] of rule.body.matchAll(/(?:^|;)\s*color:\s*([^;]+)/g)) {
        declared += 1;
        const token = /^var\((--[a-z-]+)\)$/.exec(value?.trim() ?? '')?.[1];
        expect(token, `${rule.selector} paints with ${value?.trim()}`).toBeDefined();
        expect(allowed.has(token ?? ''), `${token} is not a colour this theme defines`).toBe(true);
      }
    }
    // The scope paints in more than one place; a filter that quietly stopped
    // matching would otherwise leave this green with nothing checked.
    expect(declared).toBeGreaterThan(10);
  });

});

describe('chat prose stylesheet — scope and scrolling', () => {
  it('keeps every rule inside its own scope', () => {
    // The document body's rules are not this change's to touch.
    for (const rule of chatRules()) {
      expect(rule.selector).not.toContain('.doc-body-editor');
      expect(rule.selector).not.toContain('.ProseMirror');
    }
  });

  it('leaves the document body rules in place', () => {
    const css = read('index.css');
    expect(css).toContain('.doc-body-editor .ProseMirror p');
    expect(css).toContain('.doc-body-editor .ProseMirror blockquote');
    expect(css).toMatch(/\.doc-body-editor \.ProseMirror h1\s*\{/);
  });

  it('holds table cells on one line so the scroller has something to scroll', () => {
    const table = chatRules().find((r) => /\.chat-markdown table\s*$/.test(r.selector));
    expect(table?.body).toMatch(/white-space:\s*nowrap/);
  });

  it('declares no scroller of its own', () => {
    // Every visible scroller goes through the ScrollArea component; a raw
    // overflow here would be one the guard cannot see, since it reads TSX.
    for (const rule of chatRules()) {
      expect(rule.body).not.toMatch(/overflow(-[xy])?:\s*(auto|scroll)/);
    }
  });
});

describe('chat prose stylesheet — every heading level is a heading (R1, R5)', () => {
  it('gives h4 through h6 their own weight and spacing', () => {
    // A model writes `#### ` freely and nothing here narrows the levels, so
    // these arrive. Tailwind's preflight resets a heading to body text, which
    // leaves an unstyled one indistinguishable from the paragraph before it.
    for (const level of ['h4', 'h5', 'h6']) {
      const rule = chatRules().find((r) =>
        r.selector.split(',').some((part) => part.trim() === `.chat-markdown ${level}`),
      );
      expect(rule, `${level} has no rule`).toBeDefined();
      expect(rule?.body, `${level} declares no weight`).toMatch(/font-weight:/);
      expect(rule?.body, `${level} declares no margin`).toMatch(/margin/);
    }
  });
});
