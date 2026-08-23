// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Assistant prose, rendered as markdown.
 *
 * The whole message goes through one renderer. A footnote's reference and its
 * definition are two blocks, as are a reference-style link's use and its
 * address; they only meet inside one parse. Update frequency is `useChat`'s
 * own `throttle`, so this runs on a settled interval rather than per token.
 *
 * Inline HTML stays escaped: the pipeline carries no `rehype-raw`, which is
 * what react-markdown means by secure by default.
 */
import type { ReactElement, ReactNode } from 'react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import remend from 'remend';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { HIGHLIGHT_LANGUAGES } from '@web/pages/project/chat/highlight-languages';

interface MarkdownMessageProps {
  /** The assistant's prose, as markdown. */
  content: string;
  /** Whether this turn is still receiving tokens. */
  streaming?: boolean;
}

/**
 * Which markers get closed while a reply is still arriving.
 *
 * Every switch is given a value: leaving one to its default is not a decision.
 * `inlineCode` and `italic` are off because with them on, a lone backtick or a
 * C pointer earlier in the prose takes the closing mark and the marker actually
 * being streamed stays open. `linkMode` is `text-only` because the other mode
 * closes a half-typed link into a `streamdown:incomplete-link` anchor, which in
 * a single-page app is a full reload.
 */
const COMPLETION = {
  bold: true,
  boldItalic: true,
  strikethrough: true,
  links: true,
  linkMode: 'text-only',
  images: true,
  htmlTags: true,
  inlineCode: false,
  italic: false,
  singleTilde: true,
  comparisonOperators: true,
  setextHeadings: true,
  katex: true,
  inlineKatex: false,
} as const;

const REMARK_PLUGINS = [remarkGfm];

const REHYPE_PLUGINS = [[rehypeHighlight, { languages: HIGHLIGHT_LANGUAGES }]] as const;

/**
 * A wide table scrolls sideways through the app's own scroller.
 * @param root0 - The props react-markdown hands a `table`.
 * @param root0.children - The rows.
 * @returns The table inside a horizontal scroller.
 */
function ScrollableTable({ children }: { children?: ReactNode }): ReactElement {
  return (
    <ScrollArea className='my-[1.1em]' scrollbars='horizontal'>
      <table>{children}</table>
    </ScrollArea>
  );
}

/**
 * The tick a task list item carries, drawn rather than left to the browser.
 * @param root0 - The props react-markdown hands an `input`.
 * @param root0.checked - Whether the item is ticked.
 * @returns The mark.
 */
function TaskMark({ checked }: { checked?: boolean }): ReactElement {
  return (
    <span
      aria-hidden
      className='chat-markdown-task-mark'
      data-checked={checked === true ? 'true' : undefined}
    >
      {checked === true ? '✓' : ''}
    </span>
  );
}

/**
 * Tag-to-component overrides.
 *
 * Module level on purpose: React decides whether it can keep a DOM node by
 * comparing component identity, so a table rebuilt from a fresh function every
 * update loses its scroll position, and an image is torn down and re-fetched.
 */
const COMPONENTS: Components = {
  table: ScrollableTable,
  input: TaskMark,
};

/**
 * Draw one assistant message.
 * @param root0 - The component props.
 * @param root0.content - The assistant's prose, as markdown.
 * @param root0.streaming - Whether this turn is still receiving tokens.
 * @returns The rendered prose.
 */
export function MarkdownMessage({
  content,
  streaming = false,
}: MarkdownMessageProps): ReactElement {
  // A settled message goes through untouched. An interrupted reply carries
  // unclosed markers, and those are what the model actually sent.
  const source = streaming ? remend(content, COMPLETION) : content;

  return (
    <div
      className='chat-markdown text-sm'
      data-streaming={streaming ? 'true' : undefined}
      data-testid='markdown-body'
    >
      <Markdown
        components={COMPONENTS}
        rehypePlugins={REHYPE_PLUGINS as never}
        remarkPlugins={REMARK_PLUGINS}
      >
        {source}
      </Markdown>
    </div>
  );
}
