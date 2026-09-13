// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AnnotationBody } from '@web/spaces/canvas/annotation/AnnotationBody';

/**
 * Render some markdown and hand back the container to read tags off.
 * @param source - The annotation body as the author typed it.
 * @returns The rendered root element.
 */
const body = (source: string): HTMLElement => {
  const { container } = render(<AnnotationBody source={source} />);
  return container;
};

describe('the six marks an annotation understands', () => {
  it('draws bold, italic and strikethrough', () => {
    const el = body('**loud** and *soft* and ~~gone~~');
    expect(el.querySelector('strong')).toHaveTextContent('loud');
    expect(el.querySelector('em')).toHaveTextContent('soft');
    expect(el.querySelector('del')).toHaveTextContent('gone');
  });

  it('draws a link, and opens it away from the canvas', () => {
    // A canvas is a workspace with unsaved gestures in it. Following a link in
    // place would take the reader off it, so the link opens elsewhere.
    body('see [the brief](https://example.com/brief)');
    const link = screen.getByRole('link', { name: 'the brief' });
    expect(link).toHaveAttribute('href', 'https://example.com/brief');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('draws both kinds of list', () => {
    const bullets = body('- one\n- two');
    expect(bullets.querySelectorAll('ul li')).toHaveLength(2);
    const numbers = body('1. one\n2. two');
    expect(numbers.querySelectorAll('ol li')).toHaveLength(2);
  });
});

describe('what an annotation deliberately does not understand', () => {
  it('leaves a heading as the characters that were typed', () => {
    // Not dropped and not promoted: the reader sees what the author typed, and
    // a 200px sticky never grows a page heading.
    const el = body('# not a heading');
    expect(el).toHaveTextContent('# not a heading');
    expect(el.querySelector('h1')).toBeNull();
  });

  it('leaves a fenced block as the characters that were typed', () => {
    const el = body('```\nnpm run dev\n```');
    expect(el.textContent).toContain('```');
    expect(el.textContent).toContain('npm run dev');
    expect(el.querySelector('pre')).toBeNull();
    expect(el.querySelector('code')).toBeNull();
  });

  it('leaves inline backticks, a quote and a rule as typed', () => {
    expect(body('run `pnpm dev` first')).toHaveTextContent('run `pnpm dev` first');
    expect(body('> quoted')).toHaveTextContent('> quoted');
    expect(body('---')).toHaveTextContent('---');
  });

  it('renders no image, whatever the author wrote', () => {
    const el = body('![shot](https://example.com/a.png)');
    expect(el.querySelector('img')).toBeNull();
    expect(el).toHaveTextContent('![shot](https://example.com/a.png)');
  });

  it('escapes inline HTML rather than rendering it', () => {
    const el = body('<b>not bold</b> <script>alert(1)</script>');
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el).toHaveTextContent('<b>not bold</b>');
  });
});
