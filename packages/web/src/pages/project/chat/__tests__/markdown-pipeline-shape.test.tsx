// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Claims about the pipeline's shape, which its output cannot settle.
 *
 * Whether a DOM node survived an update, which completion switches were asked
 * for, and whether a package is installed are all invisible in a single render
 * of finished markup.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

const remendCalls: unknown[] = [];
const katexCalls: unknown[] = [];

vi.mock('remend', async (importOriginal) => {
  const actual = await importOriginal<{ default:(t: string, o?: unknown) => string }>();
  return {
    default: (text: string, options?: unknown) => {
      remendCalls.push(options);
      return actual.default(text, options as never);
    },
  };
});

vi.mock('rehype-katex', async (importOriginal) => {
  const actual = await importOriginal<{ default:(o?: unknown) => unknown }>();
  return {
    default: (options?: unknown) => {
      katexCalls.push(options);
      return actual.default(options as never);
    },
  };
});

const { MarkdownMessage } = await import('@web/pages/project/chat/MarkdownMessage');

describe('markdown pipeline — what is installed (R4)', () => {
  it('carries no package that would render inline HTML', () => {
    // The behaviour is pinned elsewhere; this pins the door it would come
    // through, so nobody adds the package back and quietly changes it.
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    expect(declared).not.toContain('rehype-raw');
    // Any fork or wrapper of it would arrive under the same prefix. Matching
    // 'raw' anywhere is too wide: @excalidraw/excalidraw contains it.
    expect(declared.filter((name) => name.startsWith('rehype-raw'))).toEqual([]);
  });
});

describe('markdown pipeline — completion switches (R2, R3)', () => {
  it('asks remend for exactly the settled set', () => {
    // Leaving a switch to its default is not a decision, and a later version
    // of the package could change what that default is.
    remendCalls.length = 0;
    render(<MarkdownMessage content='a line' streaming />);

    expect(remendCalls).toHaveLength(1);
    expect(remendCalls[0]).toEqual({
      bold: true,
      boldItalic: true,
      strikethrough: true,
      links: true,
      linkMode: 'protocol',
      images: true,
      htmlTags: true,
      inlineCode: true,
      italic: true,
      singleTilde: true,
      comparisonOperators: true,
      setextHeadings: true,
      katex: true,
      inlineKatex: false,
    });
  });

  it('asks katex for exactly the settled set', () => {
    // Same rule as the line above. `displayMode` and `throwOnError` are not
    // here because rehype-katex owns them: its own option type is
    // `Omit<KatexOptions, 'displayMode' | 'throwOnError'>`.
    katexCalls.length = 0;
    render(<MarkdownMessage content='a line' streaming={false} />);

    expect(katexCalls).toHaveLength(1);
    expect(katexCalls[0]).toEqual({
      // KaTeX's own default is a hard-coded #cc0000, which owns no place in
      // either theme. The grey is what @streamdown/math ships.
      errorColor: 'var(--color-muted-foreground)',
      // Seven commands ask this before they run: `\href`, `\url`, the four
      // `\html*` ones and `\includegraphics`. The `\html*` four write a class,
      // an id, a style or a data attribute of the model's choosing into our
      // DOM, and `\includegraphics` sends the browser after a URL of its
      // choosing.
      trust: false,
      // The rest are the values KaTeX runs on with nothing passed, written out
      // because a later version could change what running on nothing means.
      // @streamdown/math sets only errorColor and runs on every one of these:
      // https://github.com/vercel/streamdown/tree/main/packages/streamdown-math
      // `macros`, `minRuleThickness` and `colorIsTextColor` are absent because
      // they are not switches: KaTeX documents no default for any of the
      // three, and it writes into `macros` — one object shared by every render
      // would carry a reply's `\gdef` into the next one.
      output: 'htmlAndMathml',
      strict: 'warn',
      maxExpand: 1000,
      maxSize: Infinity,
      fleqn: false,
      leqno: false,
      globalGroup: false,
    });
  });

  it('runs nothing again when nothing about the message changed', () => {
    // A reply arriving piece by piece re-renders everything beside it every
    // 50ms, and parsing markdown is the expensive part of this component. An
    // expanded thinking block is the case that shows it: its text is settled
    // while the reply beside it grows.
    remendCalls.length = 0;
    const { rerender } = render(<MarkdownMessage content='a line' streaming />);
    rerender(<MarkdownMessage content='a line' streaming />);

    expect(remendCalls).toHaveLength(1);
  });

  it('leaves a settled message out of completion entirely', () => {
    remendCalls.length = 0;
    render(<MarkdownMessage content='a line' streaming={false} />);

    expect(remendCalls).toHaveLength(0);
  });
});

describe('markdown pipeline — nodes survive an update (R9, R12)', () => {
  it('keeps the same table and image across a re-render', () => {
    // React decides whether it can keep a DOM node by comparing component
    // identity. Build the components map inside the render and every mapped
    // element is torn down and rebuilt — a table losing its scroll position
    // every 50ms. The image is drawn from the tag name, so it stands for the
    // rest of the tree: whatever the map does, an update leaves it alone.
    const prose = '| a | b |\n|---|---|\n| 1 | 2 |\n\n![x](https://example.com/a.png)';
    const { rerender, container } = render(
      <MarkdownMessage content={prose} streaming />,
    );

    const tableBefore = container.querySelector('table');
    const imageBefore = container.querySelector('img');
    expect(tableBefore).not.toBeNull();
    expect(imageBefore).not.toBeNull();

    rerender(<MarkdownMessage content={`${prose}\n\none more line`} streaming />);

    expect(container.querySelector('table')).toBe(tableBefore);
    expect(container.querySelector('img')).toBe(imageBefore);
  });
});

describe('markdown pipeline — languages outside the set (R10)', () => {
  it('leaves an undeclared language and an unlabelled block uncoloured', () => {
    // Haskell is outside lowlight's `common`, and an unlabelled block reaches
    // no grammar at all — rehype-highlight's `detect` is off, so a block is
    // coloured only by naming a language the set holds.
    const { container } = render(
      <MarkdownMessage
        content={'```haskell\nmain = putStrLn "x"\n```\n\n```\nplain text\n```'}
        streaming={false}
      />,
    );

    const blocks = [...container.querySelectorAll('pre > code')];
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.querySelector('[class^="hljs-"]')).toBeNull();
    }
  });
});
