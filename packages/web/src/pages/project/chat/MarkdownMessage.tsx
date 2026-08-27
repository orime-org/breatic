// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { memo, useId, useMemo, type ReactElement, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remend from 'remend';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
// Puts a copy handler on the document, so a copied formula reads as the
// source the model wrote rather than as the glyphs it was drawn into.
import '@web/pages/project/chat/copy-formula-source';
import {
  DISPLAY_MATH_TAG,
  displayMathPlugin,
} from '@web/pages/project/chat/display-math-plugin';
import { footnoteScopePlugin } from '@web/pages/project/chat/footnote-scope-plugin';

interface MarkdownMessageProps {
  /** The assistant's prose, as markdown. */
  content: string;
  /** Whether this turn is still receiving tokens. */
  streaming?: boolean;
  /** Which step of the type scale the prose is drawn at. */
  size?: keyof typeof SIZE_CLASS;
  /** Whether a single newline in the source is a line the reader sees. */
  softBreaks?: boolean;
}

/**
 * The sizes this renderer is drawn at.
 *
 * The lengths in `.chat-markdown` are all em, based on this element, so the
 * size belongs here rather than on whatever holds it. Written out rather than
 * composed, because Tailwind finds a class by reading the source.
 */
const SIZE_CLASS = {
  sm: 'chat-markdown text-sm',
  '2xs': 'chat-markdown text-2xs',
} as const;

/**
 * Which markers get closed while a reply is still arriving.
 *
 * Every switch is given a value: leaving one to its default is not a decision,
 * and a later version of the package could change what a default is. The
 * values written here are the library's own defaults, which is what Streamdown
 * ships and therefore what a reader of any of these products is used to
 * seeing.
 *
 * They do three different things — close a marker the model has opened, escape
 * a character that would read as one (`20~25`), and drop an unclosed tag with
 * the prose after it — and all three run only while a turn is running. A
 * settled reply never goes through here, so what the reader is left with is
 * what the model sent, and the choices below are about the time in between
 * (user 2026-08-25).
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

/** The plugin lists react-markdown takes, named through the props that take them. */
type Remark = NonNullable<Options['remarkPlugins']>;
type Rehype = NonNullable<Options['rehypePlugins']>;

// `$$` on lines of their own is a formula on a line of its own, and `$$…$$`
// inside a sentence is one inside a sentence. A lone `$` is a character:
// remark-math would read it as a formula, and a price is written far more
// often than one (user 2026-08-25).
const REMARK_PLUGINS: Remark = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];

// Markdown folds a single newline into a space. Where the words were written
// one per line, `remark-breaks` makes each of those a break in the document
// itself, so it is drawn wherever the words are and travels with them when
// they are copied.
const REMARK_PLUGINS_WITH_BREAKS: Remark = [...REMARK_PLUGINS, remarkBreaks];

/**
 * How a formula is rendered.
 *
 * Every switch is given a value, for the reason `COMPLETION` above carries.
 * `displayMode` and `throwOnError` are absent because rehype-katex owns them:
 * its own option type is `Omit<KatexOptions, 'displayMode' | 'throwOnError'>`.
 */
const KATEX = {
  // KaTeX's own default is a hard-coded #cc0000, which belongs to neither
  // theme. A formula that failed to parse is shown as the LaTeX the model
  // wrote, and there is nothing the reader can do about it, so it is said
  // quietly. The grey is what @streamdown/math ships, the package Vercel's
  // Streamdown renders maths with:
  // https://github.com/vercel/streamdown/tree/main/packages/streamdown-math
  errorColor: 'var(--color-muted-foreground)',
  // Seven commands ask this before they run: `\href`, `\url`, the four
  // `\html*` ones and `\includegraphics`. The `\html*` four write a class, an
  // id, a style or a data attribute of the model's choosing into our DOM, and
  // `\includegraphics` sends the browser after a URL of its choosing.
  trust: false,
  // The rest are the values KaTeX runs on with nothing passed, written out
  // because a later version could change what running on nothing means.
  // KaTeX's options page states a default for all of them except `fleqn` and
  // `leqno`, whose entries in its settings schema carry no `default` field;
  // both are read as `if (settings.fleqn)`, so the value below is what an
  // absent one already does. @streamdown/math sets only errorColor and runs
  // on every one of these.
  // `macros`, `minRuleThickness` and `colorIsTextColor` are absent because
  // they are not switches: KaTeX documents no default for any of the three,
  // and it writes into `macros` — one object shared by every render would
  // carry a reply's `\gdef` into the next one.
  output: 'htmlAndMathml',
  strict: 'warn',
  maxExpand: 1000,
  maxSize: Infinity,
  fleqn: false,
  leqno: false,
  globalGroup: false,
} as const;

// Handed no language set, `rehype-highlight` colours with lowlight's `common`
// — thirty-seven grammars, all of which it imports at the top of its own
// module whatever it is given. Its `detect` stays off, so a block reaches a
// grammar only by naming one.
const REHYPE_TAIL: Rehype = [rehypeHighlight];

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
 * A formula on a line of its own scrolls sideways through the app's scroller.
 *
 * The margin moves out here for the reason the table's does — left inside,
 * `.chat-markdown > :first-child` would clear the scroller's margin instead
 * of the formula's, and a reply that opens with a formula would carry a gap.
 * @param root0 - The props react-markdown hands the wrapper.
 * @param root0.children - The rendered formula.
 * @returns The formula inside a horizontal scroller.
 */
function ScrollableMath({ children }: { children?: ReactNode }): ReactElement {
  return (
    <ScrollArea className='my-[1em] [&_.katex-display]:my-0' scrollbars='horizontal'>
      {children}
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
  [DISPLAY_MATH_TAG]: ScrollableMath,
} as Components;

/**
 * Draw one assistant message.
 *
 * Memoised on the way out: parsing is the expensive part of this component,
 * and a reply arriving piece by piece re-renders everything beside it every
 * 50ms. An expanded thinking block is the case that shows it — its text is
 * settled while the reply beside it grows. Every prop is a primitive, so the
 * comparison React does by default is the right one.
 * @param root0 - The component props.
 * @param root0.content - The assistant's prose, as markdown.
 * @param root0.streaming - Whether this turn is still receiving tokens.
 * @param root0.size - Which step of the type scale the prose is drawn at.
 * @param root0.softBreaks - Whether a single newline is a line the reader sees.
 * @returns The rendered prose.
 */
export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  streaming = false,
  size = 'sm',
  softBreaks = false,
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
  // The wrapping step reads what KaTeX left behind, so it follows it. The
  // footnote step runs before the colouring, which only rebuilds code
  // elements.
  const rehypePlugins = useMemo<Rehype>(
    () => [[rehypeKatex, KATEX], displayMathPlugin, [footnoteScopePlugin, scope], ...REHYPE_TAIL],
    [scope],
  );
  const remarkRehypeOptions = useMemo(
    () => ({
      footnoteLabel: footnotes,
      // Every reply in the conversation renders into one document, and the
      // library's fixed prefix would give them all the same footnote ids —
      // the second reply's marker then jumps to the first reply's note.
      clobberPrefix: `${scope}-`,
      // A note cited more than once gets one back link per citation, each
      // returning to its own. The second argument says which citation this
      // one is; the eye reads it off the ↩² the library draws, and a screen
      // reader off this label, which takes the accessible name from it.
      footnoteBackLabel: (referenceIndex: number, rereferenceIndex: number): string => {
        const name = backTo.replace('{index}', String(referenceIndex + 1));
        return rereferenceIndex > 1 ? `${name}-${rereferenceIndex}` : name;
      },
    }),
    [footnotes, backTo, scope],
  );

  return (
    <div className={SIZE_CLASS[size]} data-testid='markdown-body'>
      <Markdown
        components={COMPONENTS}
        rehypePlugins={rehypePlugins}
        remarkPlugins={softBreaks ? REMARK_PLUGINS_WITH_BREAKS : REMARK_PLUGINS}
        remarkRehypeOptions={remarkRehypeOptions}
      >
        {source}
      </Markdown>
    </div>
  );
});
