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

import { createLowlight } from 'lowlight';
import { describe, it, expect } from 'vitest';

import { HIGHLIGHT_LANGUAGES } from '@web/pages/project/chat/highlight-languages';

/** The stylesheet, comments stripped: a comment can name a selector too. */
function stylesheet(): string {
  return readFileSync(resolve(__dirname, '../../../../index.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
}

/** Every rule whose selector mentions the chat prose scope. */
function chatRules(): { selector: string; body: string }[] {
  const found: { selector: string; body: string }[] = [];
  for (const [, selector, body] of stylesheet().matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (selector?.includes('.chat-markdown') === true) {
      found.push({ selector: selector.trim(), body: body ?? '' });
    }
  }
  return found;
}

describe('chat prose stylesheet — colours come from tokens (R10)', () => {
  it('paints every highlight class with a palette token', () => {
    const rules = chatRules().filter((r) => r.selector.includes('.hljs-'));
    expect(rules.length).toBeGreaterThan(0);

    for (const rule of rules) {
      // The last declaration in a block may carry no semicolon, so the
      // terminator is optional here; requiring it hid whatever was written
      // last in each rule.
      const declarations = [...rule.body.matchAll(/(?:^|;)\s*color:\s*([^;]+)/g)];
      expect(declarations.length, `${rule.selector} declares no colour`).toBeGreaterThan(0);

      for (const [, value] of declarations) {
        expect(value?.trim()).toMatch(
          /^var\(--color-(palette-[a-z]+|muted-foreground|foreground)\)$/,
        );
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

  it('covers every class the ten declared grammars emit', () => {
    const lowlight = createLowlight(HIGHLIGHT_LANGUAGES);
    // One sample per grammar, each carrying the constructs that grammar has
    // and the others do not: a shebang and a function, every kind of CSS
    // selector, a hunk header, a decorator, a prolog and a doctype, a document
    // marker and tags.
    const samples: Record<string, string> = {
      bash: '#!/bin/bash\nfunction go() { export NAME="x"; if [ -f "$F" ]; then echo "$NAME"; fi; }',
      css: 'a:hover, div > p::first-line, #id, .cls, a[href^="http"] { color: #fff; margin: 0 auto; }',
      diff: '@@ -1,3 +1,3 @@\n--- a/x.ts\n+++ b/x.ts\n-const a = 1;\n+const a = 2;',
      xml: '<?xml version="1.0"?>\n<!DOCTYPE r>\n<div class="box" id="a">words</div>',
      javascript: 'export function f(a) { return `x ${a} z`; }',
      json: '{ "name": "x", "n": 1, "ok": true }',
      python: '@decorator\ndef f(a: int) -> int:\n    return f"v {a}"  # note',
      sql: 'SELECT id, name FROM users WHERE age > 18 ORDER BY id;',
      typescript: 'export function f(a: Foo): Bar { return a as Bar; }',
      yaml: '---\nname: !x\nitems:\n  - a\nz: !!str v',
    };
    // Every grammar in the set gets a sample: a language nobody exercises here
    // could quietly emit a class no rule paints.
    expect(Object.keys(samples).sort()).toEqual(Object.keys(HIGHLIGHT_LANGUAGES).sort());

    // Each painted selector as the SET of classes it requires. Splitting these
    // into loose names would put a bare `hljs-title` — which no rule matches,
    // and which bash emits for a function name — into the painted set.
    const paintedCombos = chatRules()
      .filter((r) => r.selector.includes('.hljs-'))
      // A rule that names a class without giving it a colour leaves that
      // token the surrounding foreground, so mentioning it is not painting.
      .filter((r) => /(?:^|;)\s*color:/.test(r.body))
      .flatMap((r) => r.selector.split(','))
      .filter((part) => part.includes('.hljs-'))
      .map((part) => {
        const last = part.trim().split(/\s+/).pop() ?? '';
        return new Set([...last.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]!));
      });

    /**
     * Whether some rule reaches an element carrying exactly these classes.
     * @param classes - The class names on one element.
     * @returns True when a selector's required classes are all present.
     */
    const isPainted = (classes: string[]): boolean =>
      paintedCombos.some((needed) => [...needed].every((c) => classes.includes(c)));

    // Containers hold other tokens and take the surrounding colour.
    const containers = new Set(['hljs-params', 'hljs-function', 'hljs-tag', 'hljs-punctuation']);

    for (const [language, code] of Object.entries(samples)) {
      const unpainted: string[] = [];
      const walk = (node: {
        properties?: { className?: string[] };
        children?: { type?: string; value?: string }[];
      }): void => {
        const classes = node.properties?.className ?? [];
        // Only spans holding their own text need a colour; a container's text
        // lives in the coloured spans inside it.
        const ownText = (node.children ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.value ?? '')
          .join('');
        if (
          classes.length > 0 &&
          ownText.trim() !== '' &&
          !classes.includes('hljs') &&
          !classes.some((c) => containers.has(c)) &&
          !isPainted(classes)
        ) {
          unpainted.push(`${classes.join('.')} (${JSON.stringify(ownText.slice(0, 20))})`);
        }
        (node.children ?? []).forEach((c) => walk(c as never));
      };
      walk(lowlight.highlight(language, code) as never);

      expect(unpainted, `${language} emits classes no rule paints`).toEqual([]);
    }
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
    const css = stylesheet();
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
