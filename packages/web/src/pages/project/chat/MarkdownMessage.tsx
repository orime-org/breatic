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
import { useTranslation } from '@web/i18n/use-translation';
import { HIGHLIGHT_LANGUAGES } from '@web/pages/project/chat/highlight-languages';
import { WaitingDot } from '@web/pages/project/chat/WaitingDot';
import {
  WAITING_DOT_TAG,
  waitingDotPlugin,
} from '@web/pages/project/chat/waiting-dot-plugin';

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
 *
 * `inlineCode` and `italic` are off because a lone backtick or a C pointer
 * earlier in the prose takes the closing mark, and the marker actually being
 * streamed stays open. `htmlTags` and `katex` are off because they close
 * constructs this pipeline never renders — inline HTML stays literal text and
 * there is no maths renderer — so in a reply their only effect is on the prose
 * around them: `htmlTags` drops everything from an unclosed `<` onward, which
 * `count<max` is enough to trigger, and `katex` appends a `$$` to any reply
 * holding an odd number of them, which a shell PID or an awk field is enough
 * to trigger.
 *
 * `setextHeadings` is on: the frame where a list item is one `-` long renders
 * the sentence above it as an h2 without it.
 *
 * `linkMode` is `text-only`; the other two modes close a half-typed link into
 * a `streamdown:incomplete-link` anchor, which in a single-page app is a full
 * reload. `links`, `images`, `singleTilde` and `comparisonOperators` return
 * the same string on or off in this configuration — measured across half-typed
 * and innocent spellings of each.
 */
const COMPLETION = {
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
} as const;

const REMARK_PLUGINS = [remarkGfm];

const HIGHLIGHT = [rehypeHighlight, { languages: HIGHLIGHT_LANGUAGES }];

const REHYPE_SETTLED = [HIGHLIGHT];

// The mark goes in after the colouring: rehype-highlight rebuilds a code
// element's children, dropping anything already placed among them.
const REHYPE_STREAMING = [HIGHLIGHT, waitingDotPlugin];

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
 *
 * The difference between a done item and an open one is the whole point of a
 * checklist, and the drawn tick carries it visually. The word beside it
 * carries the same thing for a screen reader, following the rail's pattern
 * (ReferenceRail): a `role='checkbox'` here would need an accessible name, and
 * the item's own words sit outside this element.
 * @param root0 - The props react-markdown hands an `input`.
 * @param root0.checked - Whether the item is ticked.
 * @returns The mark.
 */
function TaskMark({ checked }: { checked?: boolean }): ReactElement {
  const t = useTranslation();
  const done = checked === true;

  return (
    <>
      <span className='sr-only'>
        {done ? t('chat.markdown.taskDone') : t('chat.markdown.taskTodo')}
      </span>
      <span
        aria-hidden
        className='chat-markdown-task-mark'
        data-checked={done ? 'true' : undefined}
      >
        {done ? '✓' : ''}
      </span>
    </>
  );
}

/**
 * Tag-to-component overrides.
 *
 * Module level on purpose: React decides whether it can keep a DOM node by
 * comparing component identity, so a table rebuilt from a fresh function every
 * update loses its scroll position, and an image is torn down and re-fetched.
 */
const COMPONENTS = {
  table: ScrollableTable,
  input: TaskMark,
  // Present in both states. The element only exists while streaming, so a
  // mapping with nothing to match produces nothing; keeping it here means the
  // map itself never changes identity between renders.
  [WAITING_DOT_TAG]: WaitingDot,
} as Components;

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
        rehypePlugins={(streaming ? REHYPE_STREAMING : REHYPE_SETTLED) as never}
        remarkPlugins={REMARK_PLUGINS}
      >
        {source}
      </Markdown>
    </div>
  );
}
