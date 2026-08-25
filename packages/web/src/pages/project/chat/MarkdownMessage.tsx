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
import { useId, useMemo, type ReactElement, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import remend from 'remend';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
import { footnoteScopePlugin } from '@web/pages/project/chat/footnote-scope-plugin';

interface MarkdownMessageProps {
  /** The assistant's prose, as markdown. */
  content: string;
  /** Whether this turn is still receiving tokens. */
  streaming?: boolean;
}

/**
 * Which markers get closed while a reply is still arriving.
 *
 * Every switch is given a value: leaving one to its default is not a decision,
 * and a later version of the package could change what a default is. The
 * values written here are the library's own defaults, which is what Streamdown
 * ships and therefore what a reader of any of these products is used to
 * seeing.
 *
 * What each of them does is confined to the frames between an opening marker
 * arriving and its closing one: a settled reply never runs completion, so what
 * the reader is left with is what the model sent. That makes the choices below
 * about those frames alone (user 2026-08-25).
 *
 * `linkMode` reaches the reader through `MarkdownLink` below, which sends
 * every outbound anchor to a tab of its own, so the half-typed link this mode
 * produces costs a spare tab and leaves the page it was clicked from alone.
 */
const COMPLETION = {
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
  // The library's own default, and for its own reason: a single `$` is
  // ambiguous with currency.
  inlineKatex: false,
} as const;

/** The plugin list react-markdown takes, named through the prop that takes it. */
type Rehype = NonNullable<Options['rehypePlugins']>;

const REMARK_PLUGINS = [remarkGfm];

// Handed no language set, `rehype-highlight` colours with lowlight's `common`
// — thirty-seven grammars, all of which it imports at the top of its own
// module whatever it is given. Its `detect` stays off, so a block reaches a
// grammar only by naming one.
const REHYPE: Rehype = [rehypeHighlight];

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
 * checklist. It reaches a screen reader through this element's label, and the
 * eye through a tick `index.css` draws — both of which stay out of the text a
 * reader selects and copies, so a copied checklist reads as the model wrote
 * it. `role='img'` is what gives the label a reader to reach: a label on a
 * bare span has no role to attach to.
 * @param root0 - The props react-markdown hands an `input`.
 * @param root0.checked - Whether the item is ticked.
 * @returns The mark.
 */
function TaskMark({ checked }: { checked?: boolean }): ReactElement {
  const t = useTranslation();
  const done = checked === true;

  return (
    <span
      aria-label={done ? t('chat.markdown.taskDone') : t('chat.markdown.taskTodo')}
      className='chat-markdown-task-mark'
      data-checked={done ? 'true' : undefined}
      role='img'
    />
  );
}

/**
 * A link the agent wrote, which leads away from the app.
 *
 * The reader is part-way through making something; following a link in this
 * tab takes the canvas, the project and the running turn with it. Streamdown
 * hands its own links `target="_blank"` for the same reason, and the app's
 * other outbound links already carry both attributes.
 *
 * A footnote marker is an anchor as well and leads to a place on this page, so
 * it keeps the tab it is in.
 * @param root0 - The props react-markdown hands an `a`.
 * @param root0.href - Where it leads.
 * @param root0.children - The words it is on.
 * @returns The link.
 */
function MarkdownLink({
  href,
  children,
  ...rest
}: { href?: string; children?: ReactNode }): ReactElement {
  const staysHere = href?.startsWith('#') === true;

  return (
    <a
      href={href}
      rel={staysHere ? undefined : 'noopener noreferrer'}
      target={staysHere ? undefined : '_blank'}
      {...rest}
    >
      {children}
    </a>
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
  a: MarkdownLink,
  table: ScrollableTable,
  input: TaskMark,
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
  const t = useTranslation();
  // Unique per rendered message, so the footnote ids below are too.
  const scope = useId();
  // A settled message goes through untouched. An interrupted reply carries
  // unclosed markers, and those are what the model actually sent.
  const source = streaming ? remend(content, COMPLETION) : content;

  // remark-rehype writes the footnote section's heading and each back link's
  // label itself, and those are the only words on screen the footnote
  // machinery produces. Keyed on the strings so a language change rebuilds it.
  const footnotes = t('chat.markdown.footnotes');
  const backTo = t('chat.markdown.backToReference', { index: '{index}' });
  // Runs before the colouring, which only rebuilds code elements.
  const rehypePlugins = useMemo<Rehype>(
    () => [[footnoteScopePlugin, scope], ...REHYPE],
    [scope],
  );
  const remarkRehypeOptions = useMemo(
    () => ({
      footnoteLabel: footnotes,
      // Every reply in the conversation renders into one document, and the
      // library's fixed prefix would give them all the same footnote ids —
      // the second reply's marker then jumps to the first reply's note.
      clobberPrefix: `${scope}-`,
      // The second argument says which citation of that note this is; both
      // links land on the same place, so it is the only thing telling a
      // reader them apart.
      footnoteBackLabel: (referenceIndex: number, rereferenceIndex: number): string => {
        const name = backTo.replace('{index}', String(referenceIndex + 1));
        return rereferenceIndex > 1 ? `${name}-${rereferenceIndex}` : name;
      },
    }),
    [footnotes, backTo, scope],
  );

  return (
    <div className='chat-markdown text-sm' data-testid='markdown-body'>
      <Markdown
        components={COMPONENTS}
        rehypePlugins={rehypePlugins}
        remarkPlugins={REMARK_PLUGINS}
        remarkRehypeOptions={remarkRehypeOptions}
      >
        {source}
      </Markdown>
    </div>
  );
}
