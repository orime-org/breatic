// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Formulas in the document body (inner#1423): a block of its own
 * (`mathBlock`) and one inside a line (`math`).
 *
 * Both hold their LaTeX source as plain text and show the rendered formula in
 * its place; the source is edited in a box that opens under the formula. The
 * names and the content model are those of BlockNote's own
 * `@blocknote/math-block`, and the open / selected state is BlockNote's: the
 * two default extensions `SourceBlockWithPreviewExtension` and
 * `SourceInlineContentWithPreviewExtension` drive every spec that declares
 * `meta.hasPreview`.
 *
 * The editor is mounted with `editor.mount`, so the React layer's
 * `SourceBlockWithPreview` is out of reach. Each node view mounts a React root
 * of its own, the way the table frame does (`document-table-nodes.tsx`): the
 * source element is attached before ProseMirror reads it, and the box moves
 * that same element into place when it commits. The box stays mounted while
 * closed and only collapses (BlockNote's `Block.css`), so the arrow keys can
 * walk into the source of a formula inside a line.
 */

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import katex from 'katex';
import { autoUpdate, offset, shift, useFloating } from '@floating-ui/react';
import { Sigma, TriangleAlert, X } from 'lucide-react';
import {
  createBlockSpec,
  createInlineContentSpec,
  type BlockNoteEditor,
} from '@blocknote/core';
import {
  ReadOnlyExtension,
  SourceBlockWithPreviewExtension,
  SourceInlineContentWithPreviewExtension,
} from '@blocknote/core/extensions';
import { Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { ViewMutationRecord } from '@tiptap/pm/view';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
import { KATEX_OPTIONS } from '@web/lib/katex-options';
import { cn } from '@web/lib/utils';
import { DOC_TABLE } from '@web/spaces/document/document-table-nodes';

/** The block formula's type name. */
export const MATH_BLOCK = 'mathBlock';

/** The inline formula's type name. */
export const MATH_INLINE = 'math';

/** The attribute our own copies carry the inline source in. */
export const MATH_SOURCE_ATTR = 'data-math';

/** The attribute our own copies carry the block source in. */
export const MATH_BLOCK_SOURCE_ATTR = 'data-math-block';

/** The MathML annotation that holds a formula's LaTeX. */
const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';

/** The editor as the node views use it. */
type AnyEditor = BlockNoteEditor<never, never, never>;

/** A formula rendered, or the reason it could not be. */
type Rendered = { readonly html: string; readonly error: null } | { readonly html: null; readonly error: string };

/**
 * Renders a source with the shared options.
 * @param source - The LaTeX.
 * @param display - Whether it stands on a line of its own.
 * @param output - What KaTeX writes: both forms for the body, MathML alone for an export.
 * @returns The markup, or KaTeX's message when the source does not parse.
 * @throws {Error} Whatever KaTeX throws that is not a parse error.
 */
export function renderFormula(source: string, display: boolean, output: 'htmlAndMathml' | 'mathml' = 'htmlAndMathml'): Rendered {
  try {
    return {
      html: katex.renderToString(source, { ...KATEX_OPTIONS, output, displayMode: display, throwOnError: true }),
      error: null,
    };
  } catch (err) {
    if (err instanceof katex.ParseError) return { html: null, error: err.message.replace(/^KaTeX parse error: /, '') };
    throw err;
  }
}

/**
 * The LaTeX an element carries: our own attribute, else the TeX annotation of
 * the MathML in it.
 * @param element - A formula element from a paste or a copy.
 * @param attribute - Which of our attributes to read.
 * @returns The source; empty when there is none.
 */
function sourceOf(element: HTMLElement, attribute: string): string {
  const own = element.getAttribute(attribute);
  if (own !== null) return own;
  const annotation = element.matches(TEX_ANNOTATION) ? element : element.querySelector(TEX_ANNOTATION);
  return annotation?.textContent ?? '';
}

/**
 * The source as the node's content.
 * @param source - The LaTeX.
 * @param schema - The editor's schema.
 * @returns A text node, or nothing for an empty source.
 */
function sourceContent(source: string, schema: Schema): Fragment {
  return source === '' ? Fragment.empty : Fragment.from(schema.text(source));
}

/**
 * Whether an element is a MathML formula standing on its own line.
 * @param element - The element.
 * @returns Whether it is `<math display="block">`.
 */
function isDisplayMath(element: HTMLElement): boolean {
  return element.tagName.toLowerCase() === 'math' && element.getAttribute('display') === 'block';
}

/**
 * Whether an element is a formula block from outside: one of our copies, a
 * KaTeX display, or a block MathML formula that KaTeX did not draw.
 * @param element - The element.
 * @returns Whether it parses to a `mathBlock`.
 */
function isBlockFormula(element: HTMLElement): boolean {
  if (element.hasAttribute(MATH_BLOCK_SOURCE_ATTR)) return true;
  if (element.classList.contains('katex-display')) return true;
  return isDisplayMath(element) && element.closest('.katex') === null;
}

/**
 * Whether an element is an inline formula from outside.
 * @param element - The element.
 * @returns Whether it parses to a `math`.
 */
function isInlineFormula(element: HTMLElement): boolean {
  if (element.hasAttribute(MATH_SOURCE_ATTR)) return true;
  if (element.classList.contains('katex')) return element.closest('.katex-display') === null;
  return element.tagName.toLowerCase() === 'math' && !isDisplayMath(element) && element.closest('.katex') === null;
}

/**
 * The MathML written for a formula that KaTeX could not render, so an export
 * still carries its source.
 * @param source - The LaTeX.
 * @param display - Whether it stands on a line of its own.
 * @returns A `<math>` holding only the TeX annotation.
 */
function annotatedMath(source: string, display: boolean): HTMLElement {
  const math = document.createElement('math');
  if (display) math.setAttribute('display', 'block');
  const semantics = document.createElement('semantics');
  const annotation = document.createElement('annotation');
  annotation.setAttribute('encoding', 'application/x-tex');
  annotation.textContent = source;
  semantics.append(document.createElement('mrow'), annotation);
  math.appendChild(semantics);
  return math;
}

/**
 * The external HTML of a formula: exactly one `<math>`, KaTeX's MathML when it
 * renders and our annotated one when it does not.
 * @param source - The LaTeX.
 * @param display - Whether it stands on a line of its own.
 * @returns The element.
 */
function externalFormula(source: string, display: boolean): HTMLElement {
  const host = document.createElement(display ? 'div' : 'span');
  const rendered = source === '' ? null : renderFormula(source, display, 'mathml').html;
  if (rendered === null) host.appendChild(annotatedMath(source, display));
  else host.innerHTML = rendered;
  return host;
}

/** What a formula's face shows. */
interface FaceState {
  readonly source: string;
  /**
   * The source before the change a snapshot comparison shows, when it shows
   * one; null everywhere else.
   */
  readonly before: string | null;
  readonly open: boolean;
  readonly selected: boolean;
  readonly editable: boolean;
}

/** A face state that the node view writes and the React face reads. */
interface FaceStore {
  readonly get: () => FaceState;
  readonly set: (patch: Partial<FaceState>) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * A small store for one node view.
 * @param initial - The state to start from.
 * @returns The store.
 */
function faceStore(initial: FaceState): FaceStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      const next = { ...state, ...patch };
      if (
        next.source === state.source &&
        next.before === state.before &&
        next.open === state.open &&
        next.selected === state.selected &&
        next.editable === state.editable
      ) {
        return;
      }
      state = next;
      listeners.forEach((listener) => {
        listener();
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * A formula's source, read off its node. In a snapshot comparison the node
 * holds the old and the new source interleaved, the removed characters marked
 * deleted and the added ones inserted (BlockNote `AttributionExtension.ts`);
 * rendered together they would draw a formula neither version has. Without
 * the inserted characters it is the old source, without the deleted ones the
 * new (inner#1423 design §6.7).
 * @param node - The formula's node.
 * @returns The source now, and the one before a change the node shows.
 */
function sourcesOf(node: PMNode): Pick<FaceState, 'source' | 'before'> {
  let source = '';
  let before = '';
  let changed = false;
  node.forEach((child) => {
    const deleted = child.marks.some((mark) => mark.type.name === 'y-attributed-delete');
    const inserted = child.marks.some((mark) => mark.type.name === 'y-attributed-insert');
    changed ||= deleted || inserted;
    if (!deleted) source += child.text ?? '';
    if (!inserted) before += child.text ?? '';
  });
  return { source, before: changed ? before : null };
}

/**
 * One rendered formula, or the face that stands for it.
 * @param props - The preview.
 * @param props.html - KaTeX's markup.
 * @param props.className - Extra classes, such as a comparison's colour.
 * @returns The preview.
 */
function FormulaMarkup({ html, className }: { html: string; className?: string }): React.JSX.Element {
  // KaTeX's output for a source in our document: with `trust: false` it
  // writes formula elements only (design §6.1).
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** What the face does when the user opens or closes the box. */
interface FaceActions {
  readonly open: () => void;
  readonly close: () => void;
  readonly cancel: () => void;
}

/** What a node view does with an edit the user takes back. */
interface FormulaEditing {
  /** Opens the box. */
  readonly open: () => void;
  /** Closes the box, keeping what was typed. */
  readonly close: () => void;
  /** Writes a source back into the formula. */
  readonly restore: (source: string) => void;
}

/** Takes back what was typed in a box and closes it. */
type Cancel = () => void;

/**
 * Per editor, how to take back the edit in the one box open, for Escape.
 * A box registers itself as it opens and removes itself as it closes.
 */
const openEdits = new WeakMap<object, Cancel>();

/**
 * Takes back what was typed in the open formula box and closes it, as the
 * close button does.
 * @param editor - The editor.
 * @returns Whether a box was open.
 */
export function cancelOpenFormula(editor: object): boolean {
  const cancel = openEdits.get(editor);
  if (cancel === undefined) return false;
  cancel();
  return true;
}

/**
 * The rendered formula with its source box: what a formula looks like in the
 * body, and the box it is edited in.
 * @param props - The face.
 * @param props.store - The node view's state.
 * @param props.actions - Opening and closing the box.
 * @param props.inline - Whether the formula sits inside a line.
 * @param props.source - The source element ProseMirror edits.
 * @param props.host - The node view's element, to tell whether it sits in a table cell.
 * @returns The face.
 */
const MathFace = React.memo(function MathFace({
  store,
  actions,
  inline,
  source: sourceElement,
  host,
}: {
  store: FaceStore;
  actions: FaceActions;
  inline: boolean;
  source: HTMLElement;
  host: HTMLElement;
}): React.JSX.Element {
  const t = useTranslation();
  const { source, before, open, selected, editable } = React.useSyncExternalStore(store.subscribe, store.get);
  const shown = open && editable;
  const rendered = React.useMemo(
    () => (source === '' ? null : renderFormula(source, !inline)),
    [source, inline],
  );
  // The last formula that rendered stays up while the box is open on a source
  // that does not parse; once the box closes on it, the error face shows until
  // it parses again (BlockNote `SourceWithPreview.tsx`).
  const lastGood = React.useRef<string | null>(null);
  const errorCommitted = React.useRef(false);
  if (rendered?.html != null) lastGood.current = rendered.html;
  if (rendered?.error == null) errorCommitted.current = false;
  else if (!shown) errorCommitted.current = true;
  const error = rendered?.error ?? null;
  const preview = rendered?.html ?? (error !== null && !errorCommitted.current ? lastGood.current : null);

  const [inCell, setInCell] = React.useState(false);
  React.useLayoutEffect(() => {
    setInCell(host.closest(`[data-node-type='${DOC_TABLE}']`) !== null);
  }, [host]);
  const viewport = React.useMemo(
    () => host.closest<HTMLElement>('[data-radix-scroll-area-viewport]') ?? undefined,
    [host],
  );
  const { refs, floatingStyles } = useFloating({
    open: shown,
    placement: inline ? 'bottom-start' : 'bottom',
    strategy: inCell ? 'fixed' : 'absolute',
    middleware: [offset(4), shift({ boundary: viewport, padding: 8 })],
    whileElementsMounted: shown ? autoUpdate : undefined,
  });

  // A press outside the open box takes back what was typed, as the body's
  // other input-and-confirm boxes do (the link field drops its draft).
  const [wrapper, setWrapper] = React.useState<HTMLElement | null>(null);
  const holdWrapper = React.useCallback(
    (element: HTMLElement | null): void => {
      setWrapper(element);
      refs.setReference(element);
    },
    [refs],
  );
  React.useEffect(() => {
    if (!shown || wrapper === null) return undefined;
    /**
     * Takes the edit back when the press lands outside the formula and its box.
     * @param event - The press.
     */
    const onPress = (event: PointerEvent): void => {
      if (event.target instanceof Node && wrapper.contains(event.target)) return;
      actions.cancel();
    };
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [shown, wrapper, actions]);

  const placeSource = React.useCallback(
    (slot: HTMLElement | null): void => {
      if (slot === null || sourceElement.parentElement === slot) return;
      slot.appendChild(sourceElement);
    },
    [sourceElement],
  );

  const Wrapper = inline ? 'span' : 'div';
  const compared = React.useMemo(
    () =>
      before === null || before === source
        ? null
        : { before: renderFormula(before, !inline).html, now: renderFormula(source, !inline).html },
    [before, source, inline],
  );
  const face =
    compared !== null ? (
      // A formula a comparison shows changed: the old one in the deletion's
      // colours, the new one in the insertion's.
      <>
        {compared.before !== null && (
          <FormulaMarkup html={compared.before} className={cn(!inline && 'block', 'doc-version-delete')} />
        )}
        {compared.now !== null && (
          <FormulaMarkup html={compared.now} className={cn(!inline && 'block', 'doc-version-insert')} />
        )}
      </>
    ) : source === '' ? (
      <span className='inline-flex items-center gap-1.5 rounded-chrome bg-muted px-2 py-1 text-sm text-muted-foreground'>
        <Sigma className='h-3.5 w-3.5' aria-hidden />
        {t('spaces.document.math.empty')}
      </span>
    ) : preview === null ? (
      <span className='inline-flex items-center gap-1.5 rounded-chrome bg-muted px-2 py-1 text-sm text-muted-foreground'>
        <TriangleAlert className='h-3.5 w-3.5' aria-hidden />
        {t('spaces.document.math.error')}
      </span>
    ) : (
      <FormulaMarkup html={preview} />
    );

  return (
    <Wrapper
      ref={holdWrapper}
      className={cn('bn-preview-with-source-popup doc-math', selected && 'ProseMirror-selectednode')}
      data-open={shown ? 'true' : 'false'}
    >
      <Wrapper
        className={cn('bn-preview-container', !inline && 'overflow-visible', !editable && 'cursor-default')}
        contentEditable={false}
        role={editable && (source === '' || preview === null) ? 'button' : undefined}
        // The body keeps the keyboard: the box opens with the caret in its source.
        onMouseDown={(event) => {
          if (!editable) return;
          event.preventDefault();
          event.stopPropagation();
          actions.open();
        }}
      >
        {inline ? (
          face
        ) : (
          // A formula wider than the body scrolls sideways in its own
          // scroller, as a formula in a chat reply does (`MarkdownMessage.tsx`).
          <ScrollArea scrollbars='horizontal' className='w-full [&_.katex-display]:my-0'>
            <div className='flex w-max min-w-full flex-col items-center'>{face}</div>
          </ScrollArea>
        )}
      </Wrapper>
      <div
        ref={refs.setFloating}
        style={shown ? floatingStyles : undefined}
        className={cn(
          'bn-source-block-popup doc-math-popup',
          shown &&
            'z-20 flex w-[min(560px,calc(100vw-2rem))] flex-col rounded-overlay border border-border bg-popover text-left text-popover-foreground shadow-md',
        )}
      >
        <div
          contentEditable={false}
          className='flex shrink-0 items-center justify-between gap-2 border-b border-border py-1.5 pl-3 pr-1.5'
        >
          <span className='flex min-w-0 items-center gap-1.5 text-sm font-medium'>
            <Sigma className='h-3.5 w-3.5 shrink-0 text-muted-foreground' aria-hidden />
            <span className='truncate'>{t('spaces.document.commands.formula')}</span>
          </span>
          <Button
            variant='ghost'
            size='compact'
            aria-label={t('spaces.document.math.close')}
            className='w-[var(--btn-compact)] px-0 text-muted-foreground'
            tabIndex={shown ? undefined : -1}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={(event) => {
              event.stopPropagation();
              actions.cancel();
            }}
          >
            <X className='h-3.5 w-3.5' />
          </Button>
        </div>
        <div className='p-3'>
          <pre
            ref={placeSource}
            data-placeholder={t('spaces.document.math.placeholder')}
            data-empty={source === '' ? 'true' : 'false'}
            aria-hidden={shown ? undefined : true}
            className={cn(
              'doc-math-source relative m-0 min-h-[calc(3lh+1rem+2px)] whitespace-pre-wrap break-all rounded-chrome border border-border bg-transparent px-3 py-2 font-mono text-sm',
              'focus-within:border-active-border',
              'data-[empty=true]:before:pointer-events-none data-[empty=true]:before:absolute data-[empty=true]:before:text-muted-foreground data-[empty=true]:before:content-[attr(data-placeholder)]',
            )}
          />
          {shown && error !== null && (
            <p contentEditable={false} className='mt-1.5 text-xs text-status-error-foreground'>
              {error}
            </p>
          )}
        </div>
        <div
          contentEditable={false}
          className='flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-1.5'
        >
          <Button
            size='sm'
            tabIndex={shown ? undefined : -1}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={(event) => {
              event.stopPropagation();
              actions.close();
            }}
          >
            {t('spaces.document.math.ok')}
          </Button>
        </div>
      </div>
    </Wrapper>
  );
});

/** A node view as ProseMirror takes it. */
interface FormulaView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  update: (node: PMNode) => boolean;
  ignoreMutation: (mutation: ViewMutationRecord) => boolean;
  destroy: () => void;
}

/**
 * Mounts a formula's face around the element ProseMirror edits.
 * @param inline - Whether the formula sits inside a line.
 * @param initial - The face's first state.
 * @param editor - The editor, which Escape finds the open box through.
 * @param editing - Opening and closing the box, and writing a source back.
 * @param typeName - The node type the view stays bound to.
 * @param stop - Releases what the caller subscribed to.
 * @returns The node view.
 */
function mountFormula(
  inline: boolean,
  initial: FaceState,
  editor: AnyEditor,
  editing: FormulaEditing,
  typeName: string,
  stop: () => void,
): FormulaView & { store: FaceStore } {
  const dom = document.createElement(inline ? 'span' : 'div');
  // BlockNote's inline-formula rules key on it, and only its React layer adds
  // it (`ReactInlineContentSpec.tsx`). A block formula spans its line, which
  // BlockNote lays out as a flex row.
  dom.className = inline ? 'bn-inline-content-section' : 'w-full min-w-0';
  const code = document.createElement('code');
  const chrome = document.createElement(inline ? 'span' : 'div');
  chrome.className = 'contents';
  // Attached before ProseMirror reads the content element; the face moves it
  // into the box when it commits.
  dom.append(code, chrome);
  const store = faceStore(initial);
  // The source as the box opened on it, which the close button, Escape and a
  // press outside put back.
  let openedWith: string | null = null;
  /** Puts the source back as it was when the box opened, and closes the box. */
  const cancel = (): void => {
    const before = openedWith;
    if (before !== null && before !== store.get().source) editing.restore(before);
    editing.close();
  };
  const actions: FaceActions = { open: editing.open, close: editing.close, cancel };
  const stopWatching = store.subscribe(() => {
    const { open, editable, source } = store.get();
    if (open && editable) {
      if (openedWith === null) {
        openedWith = source;
        openEdits.set(editor, cancel);
      }
      return;
    }
    openedWith = null;
    if (openEdits.get(editor) === cancel) openEdits.delete(editor);
  });
  const root: Root = createRoot(chrome);
  root.render(<MathFace store={store} actions={actions} inline={inline} source={code} host={dom} />);
  return {
    dom,
    contentDOM: code,
    store,
    update: (node) => {
      if (node.type.name !== typeName) return false;
      store.set(sourcesOf(node));
      return true;
    },
    // Only what happens inside the source is the document's; the face around
    // it is React's.
    ignoreMutation: (mutation) => mutation.type !== 'selection' && !code.contains(mutation.target),
    destroy: () => {
      stop();
      stopWatching();
      if (openEdits.get(editor) === cancel) openEdits.delete(editor);
      // React refuses a synchronous unmount while it is rendering, and
      // ProseMirror can tear views down from inside a React commit.
      queueMicrotask(() => {
        root.unmount();
      });
    },
  };
}

/**
 * A static copy of a formula for BlockNote's own HTML: the source inside an
 * element it can read back.
 * @param inline - Whether the formula sits inside a line.
 * @returns The element and its content element.
 */
function staticFormula(inline: boolean): { dom: HTMLElement; contentDOM: HTMLElement } {
  const dom = document.createElement(inline ? 'span' : 'div');
  const code = document.createElement('code');
  dom.appendChild(code);
  return { dom, contentDOM: code };
}

/** What `render` sees as `this` inside a node view. */
interface RenderContext {
  readonly renderType?: 'nodeView' | 'dom';
  readonly props?: { readonly node: PMNode };
}

/** The block as `render` receives it. */
interface FormulaBlock {
  readonly id: string;
  readonly content?: readonly { readonly text?: string }[] | string;
}

/**
 * The text of a block or inline formula as BlockNote hands it over.
 * @param content - Its content.
 * @returns The source.
 */
function textOf(content: FormulaBlock['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((piece) => piece.text ?? '').join('');
}

/**
 * Subscribes a block formula's face to who has its box open and whether the
 * body can be edited, and closes the box when the body turns read-only.
 * @param editor - The editor.
 * @param id - The block's id.
 * @param store - Reads the face, once the view holds one.
 * @returns The unsubscriber.
 */
function followBlock(editor: AnyEditor, id: string, store: () => FaceStore | null): () => void {
  const preview = editor.getExtension(SourceBlockWithPreviewExtension)!;
  const readOnly = editor.getExtension(ReadOnlyExtension)!;
  /** Copies the open, selected and editable state onto the face. */
  const sync = (): void => {
    const face = store();
    if (face === null) return;
    const editable = editor.isEditable;
    if (!editable && preview.store.state.popupOpen === id) {
      preview.store.setState((state) => ({ ...state, popupOpen: undefined }));
      return;
    }
    face.set({
      open: preview.store.state.popupOpen === id,
      selected: preview.store.state.selected === id,
      editable,
    });
  };
  const stopPreview = preview.store.subscribe(sync);
  const stopReadOnly = readOnly.store.subscribe(sync);
  queueMicrotask(sync);
  return () => {
    stopPreview();
    stopReadOnly();
  };
}

/**
 * The block formula.
 * @returns The block spec.
 */
export function mathBlockSpec(): unknown {
  return createBlockSpec(
    {
      type: MATH_BLOCK,
      propSchema: { quoted: { default: false } },
      content: 'plain',
    },
    {
      meta: { hasPreview: true, code: true },
      // Backspace at the start of an empty source would turn the block into a
      // paragraph; this keeps it a formula, and our keys handle the rest.
      experimental_keyboard: { resetsTo: { type: MATH_BLOCK } },
      parse: (element: HTMLElement) => (isBlockFormula(element) ? {} : undefined),
      parseContent: ({ el, schema }: { el: HTMLElement; schema: Schema }) =>
        isBlockFormula(el) ? sourceContent(sourceOf(el, MATH_BLOCK_SOURCE_ATTR), schema) : undefined,
      render(this: RenderContext, block: FormulaBlock, editor: AnyEditor) {
        if (this.renderType !== 'nodeView') return staticFormula(false);
        let view: (FormulaView & { store: FaceStore }) | null = null;
        const stop = followBlock(editor, block.id, () => view?.store ?? null);
        const preview = editor.getExtension(SourceBlockWithPreviewExtension)!;
        view = mountFormula(
          false,
          {
            ...(this.props === undefined ? { source: textOf(block.content), before: null } : sourcesOf(this.props.node)),
            open: false,
            selected: false,
            editable: editor.isEditable,
          },
          editor,
          {
            open: () => {
              if (!editor.isEditable) return;
              preview.store.setState((state) => ({ ...state, popupOpen: block.id }));
              editor.setTextCursorPosition(block.id, 'end');
              editor.focus();
            },
            close: () => {
              preview.store.setState((state) => ({ ...state, popupOpen: undefined }));
              editor.focus();
            },
            restore: (source) => {
              editor.updateBlock(block.id, { content: source } as never);
              editor.setTextCursorPosition(block.id, 'end');
            },
          },
          MATH_BLOCK,
          stop,
        );
        return view;
      },
      toExternalHTML: (block: FormulaBlock) => ({ dom: externalFormula(textOf(block.content), true) }),
    } as never,
  )();
}

/** The arguments an inline formula's `render` receives inside a node view. */
type InlineRenderArgs = [
  inlineContent: FormulaBlock,
  update: unknown,
  editor: AnyEditor,
  node?: PMNode,
  getPos?: () => number | undefined,
];

/**
 * The inline formula.
 * @returns The inline content spec.
 */
export function mathInlineSpec(): unknown {
  return createInlineContentSpec(
    { type: MATH_INLINE, propSchema: {}, content: 'plain' },
    {
      meta: { hasPreview: true, code: true },
      parse: (element: HTMLElement) => (isInlineFormula(element) ? {} : undefined),
      parseContent: ({ el, schema }: { el: HTMLElement; schema: Schema }) =>
        isInlineFormula(el) ? sourceContent(sourceOf(el, MATH_SOURCE_ATTR), schema) : undefined,
      render(this: RenderContext, ...[, , editor, node, getPos]: InlineRenderArgs) {
        if (this.renderType !== 'nodeView' || getPos === undefined || node === undefined) {
          return staticFormula(true);
        }
        const preview = editor.getExtension(SourceInlineContentWithPreviewExtension)!;
        const readOnly = editor.getExtension(ReadOnlyExtension)!;
        let current = node;
        let view: (FormulaView & { store: FaceStore }) | null = null;
        /** Copies whether the selection is in this source, and editability, onto the face. */
        const sync = (): void => {
          const pos = getPos();
          view?.store.set({
            selected: pos !== undefined && preview.store.state.selected === pos,
            open: pos !== undefined && preview.store.state.selected === pos,
            editable: editor.isEditable,
          });
        };
        const stopPreview = preview.store.subscribe(sync);
        const stopReadOnly = readOnly.store.subscribe(sync);
        view = mountFormula(
          true,
          { ...sourcesOf(node), open: false, selected: false, editable: editor.isEditable },
          editor,
          {
            open: () => {
              const pos = getPos();
              if (!editor.isEditable || pos === undefined) return;
              const pmView = editor.prosemirrorView!;
              pmView.dispatch(
                pmView.state.tr.setSelection(TextSelection.create(pmView.state.doc, pos + current.nodeSize - 1)),
              );
              editor.focus();
            },
            close: () => {
              const pos = getPos();
              if (pos === undefined) return;
              const pmView = editor.prosemirrorView!;
              pmView.dispatch(
                pmView.state.tr.setSelection(TextSelection.create(pmView.state.doc, pos + current.nodeSize)),
              );
              editor.focus();
            },
            restore: (source) => {
              const pos = getPos();
              if (pos === undefined) return;
              const pmView = editor.prosemirrorView!;
              const { state } = pmView;
              const content = source === '' ? [] : [state.schema.text(source)];
              const tr = state.tr.replaceWith(pos + 1, pos + current.nodeSize - 1, content);
              pmView.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1 + source.length)));
            },
          },
          MATH_INLINE,
          () => {
            stopPreview();
            stopReadOnly();
          },
        );
        const update = view.update;
        view.update = (next: PMNode): boolean => {
          if (!update(next)) return false;
          current = next;
          sync();
          return true;
        };
        queueMicrotask(sync);
        return view;
      },
      toExternalHTML: (inlineContent: FormulaBlock) => ({ dom: externalFormula(textOf(inlineContent.content), false) }),
    } as never,
  );
}
