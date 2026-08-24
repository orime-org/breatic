// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

vi.mock('remend', async (importOriginal) => {
  const actual = await importOriginal<{ default:(t: string, o?: unknown) => string }>();
  return {
    default: (text: string, options?: unknown) => {
      remendCalls.push(options);
      return actual.default(text, options as never);
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
      linkMode: 'text-only',
      images: true,
      htmlTags: false,
      inlineCode: false,
      italic: false,
      singleTilde: true,
      comparisonOperators: true,
      setextHeadings: true,
      katex: false,
      inlineKatex: false,
    });
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
    // every 50ms, an image re-fetched at the same rate.
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
