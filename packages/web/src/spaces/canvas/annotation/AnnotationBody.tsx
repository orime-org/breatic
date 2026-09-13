// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * An annotation's words, drawn.
 *
 * Six marks (#1881 §11.2): bold, italic, strikethrough, links, and the two
 * kinds of list. The author types the markdown; there is no toolbar, which is
 * how Figma, Linear and GitHub all handle a comment box.
 *
 * Inline HTML stays escaped — the pipeline carries no `rehype-raw`, which is
 * what react-markdown means by secure by default, and these words come from
 * another member of the project.
 */

import * as React from 'react';
import Markdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { keepUnsupportedAsTyped } from '@web/spaces/canvas/annotation/keep-unsupported-as-typed';

/**
 * The tags this renderer emits. Anything the plugin did not already hand back
 * as text would be dropped here, so the two lists say the same thing twice on
 * purpose: the plugin decides what the reader sees, this is the floor under it.
 */
const DRAWN_TAGS = [
  'p',
  'strong',
  'em',
  'del',
  'a',
  'ul',
  'ol',
  'li',
] as const;

const PLUGINS: Options['remarkPlugins'] = [remarkGfm, keepUnsupportedAsTyped];

const COMPONENTS: Components = {
  // A canvas holds unsaved gestures — a selection, a half-dragged group — and
  // following a link in place would take all of it away. `noreferrer` rides
  // along with `noopener`, which is what keeps the new tab from reaching back.
  // `node` is react-markdown's own prop — the mdast node behind this element.
  // Spread onto the anchor it reaches the DOM as `node="[object Object]"`,
  // which a real board showed and no unit assertion had been looking for.
  a: ({ children, node: _node, ...props }) => (
    <a {...props} target='_blank' rel='noopener noreferrer'>
      {children}
    </a>
  ),
};

interface AnnotationBodyProps {
  /** The body, as the author typed it. */
  source: string;
}

/**
 * Draw an annotation or reply body.
 * @param root0 - The component props.
 * @param root0.source - The body, as the author typed it.
 * @returns The rendered prose.
 */
export const AnnotationBody = React.memo(function AnnotationBody({
  source,
}: AnnotationBodyProps): React.JSX.Element {
  return (
    // `annotation-body` is the scope the stylesheet writes against (index.css,
    // `@layer components`). Preflight clears a list's markers and a link's
    // colour, and those rules are what put them back — renamed here and
    // nowhere else, two of the six marks silently stop being drawn.
    <div className='annotation-body text-xs'>
      <Markdown
        remarkPlugins={PLUGINS}
        allowedElements={DRAWN_TAGS as unknown as string[]}
        components={COMPONENTS}
      >
        {source}
      </Markdown>
    </div>
  );
});
