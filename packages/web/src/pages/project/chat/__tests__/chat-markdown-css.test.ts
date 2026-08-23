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
      for (const [, value] of rule.body.matchAll(/color:\s*([^;]+);/g)) {
        expect(value?.trim()).toMatch(
          /^var\(--color-(palette-[a-z]+|muted-foreground)\)$/,
        );
      }
    }
  });

  it('names both classes wherever a title is coloured', () => {
    // Functions and types share hljs-title; the second class is what tells
    // them apart, so naming only the first paints one the other's colour.
    const titleRules = chatRules().filter((r) => r.selector.includes('.hljs-title'));
    expect(titleRules.length).toBeGreaterThan(0);

    for (const rule of titleRules) {
      for (const part of rule.selector.split(',')) {
        if (!part.includes('.hljs-title')) continue;
        expect(part).toMatch(/\.hljs-title\.(function_|class_)/);
      }
    }
  });

  it('covers every class the ten declared grammars emit', () => {
    const lowlight = createLowlight(HIGHLIGHT_LANGUAGES);
    const samples: Record<string, string> = {
      bash: 'export NAME="x"\nif [ -f "$FILE" ]; then echo "$NAME"; fi',
      css: '.foo { color: #fff; margin: 0 auto; }',
      diff: '--- a/x.ts\n+++ b/x.ts\n-const a = 1;\n+const a = 2;',
      xml: '<div class="box" id="a">words</div>',
      javascript: 'export function f(a) { return a.map((n) => n * 2); }',
      json: '{ "name": "x", "n": 1, "ok": true }',
      python: 'def f(a: int) -> int:\n    return a * 2  # note',
      sql: 'SELECT id, name FROM users WHERE age > 18 ORDER BY id;',
      typescript: 'export function f(a: Foo): Bar { return a as Bar; }',
      yaml: 'name: x\nitems:\n  - a\n  - b',
    };
    // Every grammar in the set gets a sample: a language nobody exercises here
    // could quietly emit a class no rule paints.
    expect(Object.keys(samples).sort()).toEqual(Object.keys(HIGHLIGHT_LANGUAGES).sort());

    const styled = chatRules()
      .filter((r) => r.selector.includes('.hljs-'))
      .flatMap((r) => [...r.selector.matchAll(/\.(hljs-[a-z_-]+|function_|class_)/g)])
      .map((m) => m[1]);

    // Containers hold other tokens and take the surrounding colour.
    const containers = new Set(['hljs-params', 'hljs-function', 'hljs-tag', 'hljs-punctuation']);

    for (const [language, code] of Object.entries(samples)) {
      const emitted = new Set<string>();
      const walk = (node: { properties?: { className?: string[] }; children?: unknown[] }): void => {
        (node.properties?.className ?? []).forEach((c) => emitted.add(c));
        (node.children ?? []).forEach((c) => walk(c as never));
      };
      walk(lowlight.highlight(language, code) as never);

      for (const className of emitted) {
        if (className === 'hljs' || containers.has(className)) continue;
        expect(
          styled.includes(className),
          `${language} emits ${className}, which no rule paints`,
        ).toBe(true);
      }
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
