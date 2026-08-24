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
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { common, createLowlight } from 'lowlight';
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
 * The palette colours the theme actually defines.
 *
 * A name shaped like a token but spelt wrong resolves to nothing, and the
 * class it was meant to paint takes the surrounding colour instead.
 * @returns Every declared `--color-palette-*` name.
 */
function paletteTokens(): Set<string> {
  const names = new Set<string>();
  postcss.parse(read('theme/tokens.css')).walkDecls((decl) => {
    if (decl.prop.startsWith('--color-palette-')) names.add(decl.prop);
  });
  return names;
}

describe('chat prose stylesheet — colours come from tokens (R10)', () => {
  it('paints every highlight class with a palette token', () => {
    const allowed = new Set([...paletteTokens(), '--color-muted-foreground', '--color-foreground']);
    expect(allowed.size).toBeGreaterThan(3);

    // `.hljs` without a dash is the code element's own class, and a colour on
    // it lands on every token that has none of its own.
    const rules = chatRules().filter((r) => /\.hljs\b/.test(r.selector));
    expect(rules.length).toBeGreaterThan(0);

    for (const rule of rules) {
      // The last declaration in a block may carry no semicolon, so the
      // terminator is optional here; requiring it hid whatever was written
      // last in each rule.
      const declarations = [...rule.body.matchAll(/(?:^|;)\s*color:\s*([^;]+)/g)];

      for (const [, value] of declarations) {
        const token = /^var\((--[a-z-]+)\)$/.exec(value?.trim() ?? '')?.[1];
        expect(token, `${rule.selector} paints with ${value?.trim()}`).toBeDefined();
        expect(allowed.has(token ?? ''), `${token} is not a colour this theme defines`).toBe(true);
      }
    }
  });

  it('separates a type name from a function name', () => {
    // Functions and types share hljs-title. A grammar that knows which kind it
    // has adds a second class; bash does not, and its `function go()` arrives
    // as a bare hljs-title — so the bare name has to be painted, and the type
    // has to win over it.
    /**
     * The colour the last rule mentioning this selector declares.
     * @param selector - The selector to look for, matched exactly.
     * @returns That colour, or undefined when no rule declares one.
     */
    const colourOf = (selector: string): string | undefined => {
      let found: string | undefined;
      for (const rule of chatRules()) {
        if (!rule.selector.split(',').some((p) => p.trim() === selector)) continue;
        const colour = /color:\s*([^;]+);/.exec(rule.body)?.[1]?.trim();
        if (colour !== undefined) found = colour;
      }
      return found;
    };

    const bare = colourOf('.chat-markdown .hljs-title');
    const type = colourOf('.chat-markdown .hljs-title.class_');
    expect(bare).toBeDefined();
    expect(type).toBeDefined();
    expect(bare).not.toBe(type);
  });

  it('covers every class the grammars we ship can emit', () => {
    // The set is lowlight's `common`. Restricting it saves nothing —
    // rehype-highlight imports `common` at the top of its own module, so every
    // one of these reaches the bundle whatever is passed to it.
    const lowlight = createLowlight(common);
    const names = Object.keys(common);
    expect(names.length).toBe(37);

    // Every scope name each grammar declares, taken from the grammar itself
    // rather than from a sample: a sample only exercises the constructs
    // someone thought to write down.
    // Resolved through Node rather than by path: the grammars live wherever
    // the package manager put them.
    const require_ = createRequire(import.meta.url);
    const declared = new Set<string>();
    for (const name of names) {
      const grammar = readFileSync(require_.resolve(`highlight.js/lib/languages/${name}`), 'utf8');
      for (const [, scope] of grammar.matchAll(/(?:scope|className):\s*'([a-zA-Z_][\w.-]*)'/g)) {
        declared.add(scope!);
      }
    }
    expect(declared.size).toBeGreaterThan(40);
    expect(lowlight.registered('ruby')).toBe(true);

    // Each painted selector as the SET of classes it requires. Splitting these
    // into loose names would put a bare `hljs-title` — which no rule matches,
    // and which bash emits for a function name — into the painted set.
    const paintedCombos = chatRules()
      .filter((r) => r.selector.includes('.hljs-'))
      // A rule that names a class and declares nothing leaves that token the
      // surrounding foreground. Markdown's bold and italic are meant to take
      // it — they name a shape, not a kind of token — so a weight or a slant
      // counts as having been dealt with.
      .filter((r) => /(?:^|;)\s*(?:color|font-weight|font-style):/.test(r.body))
      .flatMap((r) => r.selector.split(','))
      .filter((part) => part.includes('.hljs-'))
      .map((part) => {
        const last = part.trim().split(/\s+/).pop() ?? '';
        return new Set([...last.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]!));
      });

    // Containers hold other tokens and take the surrounding colour.
    const containers = new Set(['params', 'function', 'tag', 'punctuation']);

    const unpainted = [...declared]
      .filter((scope) => !containers.has(scope.split('.')[0]!))
      .filter((scope) => {
        // highlight.js writes `a.b` as class `hljs-a` plus class `b`.
        const [head, tail] = scope.split('.');
        const classes = tail === undefined ? [`hljs-${head}`] : [`hljs-${head}`, tail];
        return !paintedCombos.some((needed) => [...needed].every((c) => classes.includes(c)));
      });

    expect(unpainted, 'scopes no rule paints').toEqual([]);
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
