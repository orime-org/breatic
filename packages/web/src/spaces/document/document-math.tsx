// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Formulas in the document body (inner#1423): a block of its own
 * (`mathBlock`) and one inside a line (`math`).
 *
 * Both are leaves holding their LaTeX in a `source` prop and draw the
 * rendered formula in its place; the source is edited in a text field in a
 * box that opens under the formula, and each change is written straight to
 * the prop. No text of the formula sits in the body, so the body's caret,
 * selections and deletions reach a formula only whole. This is the shape
 * Tiptap's mathematics extension (`latex` attribute), Plate (`texExpression`)
 * and Lexical (`EquationEditor`) take.
 *
 * The editor is mounted with `editor.mount`, so each node view mounts a React
 * root of its own, the way the table frame does (`document-table-nodes.tsx`).
 * The box is a control region, as the media block's controls are
 * (`document-media-blocknote.ts`): its events are the browser's.
 */

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import katex from 'katex';
import { autoUpdate, flip, hide, offset, shift, size, useFloating, type Middleware, type Placement } from '@floating-ui/react';
import { Sigma, TriangleAlert } from 'lucide-react';
import {
  createBlockSpec,
  createExtension,
  createInlineContentSpec,
  getNodeById,
  type BlockNoteEditor,
} from '@blocknote/core';
import { ReadOnlyExtension } from '@blocknote/core/extensions';
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { MATH_BLOCK_SOURCE_ATTR, MATH_SOURCE_ATTR, formulaSourceHolder } from '@web/lib/formula-source';
import { DISPLAY_MATH_SCROLLER, KATEX_OPTIONS } from '@web/lib/katex-options';
import { compositionEnd, keyBelongsToInputMethod, type CompositionEnd } from '@web/lib/composition-end';
import { cn } from '@web/lib/utils';
import { BODY_SCROLLER_CLASS } from '@web/spaces/document/document-body-scroller';
import { DOC_TABLE, cellDepthOf } from '@web/spaces/document/document-table-nodes';

/** The editor as the node views use it. */
type AnyEditor = BlockNoteEditor<never, never, never>;

/** The block formula's type name. */
export const MATH_BLOCK = 'mathBlock';

/** The inline formula's type name. */
export const MATH_INLINE = 'math';

/**
 * Whether a node is a formula, block or inline.
 * @param node - The node.
 * @returns True for `mathBlock` and `math`.
 */
export function isFormula(node: PMNode): boolean {
  return node.type.name === MATH_BLOCK || node.type.name === MATH_INLINE;
}

/** The MathML annotation that holds a formula's LaTeX. */
export const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';

/** A formula rendered, or the reason it could not be. */
type Rendered = { readonly html: string; readonly error: null } | { readonly html: null; readonly error: string };

/**
 * Renders a source with the shared options.
 * @param source - The LaTeX.
 * @param display - Whether it stands on a line of its own.
 * @param output - What KaTeX writes: both forms for the body, MathML alone for an export.
 * @returns The markup, or KaTeX's message when it cannot draw the source,
 *   whether the source does not parse or runs KaTeX out of stack.
 */
export function renderFormula(source: string, display: boolean, output: 'htmlAndMathml' | 'mathml' = 'htmlAndMathml'): Rendered {
  try {
    return {
      html: katex.renderToString(source, { ...KATEX_OPTIONS, output, displayMode: display, throwOnError: true }),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { html: null, error: message.replace(/^KaTeX parse error: /, '') };
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
  return element.querySelector(TEX_ANNOTATION)?.textContent ?? '';
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
 * Whether an element from outside holds a TeX annotation. MathML without one
 * stays the words it shows; a formula made from it would be empty.
 * @param element - The element.
 * @returns True when it does.
 */
function carriesTex(element: HTMLElement): boolean {
  return element.querySelector(TEX_ANNOTATION) !== null;
}

/**
 * Whether an element is a formula block from outside: one of our copies, a
 * KaTeX display, or a block MathML formula that KaTeX did not draw, carrying
 * its LaTeX.
 * @param element - The element.
 * @returns Whether it parses to a `mathBlock`.
 */
function isBlockFormula(element: HTMLElement): boolean {
  if (element.hasAttribute(MATH_BLOCK_SOURCE_ATTR)) return true;
  if (element.classList.contains('katex-display')) return carriesTex(element);
  return isDisplayMath(element) && element.closest('.katex') === null && carriesTex(element);
}

/**
 * Whether an element is an inline formula from outside, carrying its LaTeX.
 * @param element - The element.
 * @returns Whether it parses to a `math`.
 */
function isInlineFormula(element: HTMLElement): boolean {
  if (element.hasAttribute(MATH_SOURCE_ATTR)) return true;
  if (element.classList.contains('katex')) return element.closest('.katex-display') === null && carriesTex(element);
  return (
    element.tagName.toLowerCase() === 'math' &&
    !isDisplayMath(element) &&
    element.closest('.katex') === null &&
    carriesTex(element)
  );
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

/**
 * A formula's LaTeX, read off its node.
 * @param node - A `mathBlock` or `math` node.
 * @returns The source.
 */
export function formulaSource(node: PMNode): string {
  return String(node.attrs['source'] ?? '');
}

/**
 * How a formula reads as text: `$$source$$` inside a line, the source between
 * two `$$` lines for a block, as the Agent reads it.
 * @param node - A `mathBlock` or `math` node.
 * @returns The text.
 */
export function formulaLeafText(node: PMNode): string {
  const source = formulaSource(node);
  return node.type.name === MATH_BLOCK ? `$$\n${source}\n$$` : `$$${source}$$`;
}

/**
 * A leaf reader for `textBetween` that reads a formula as its text and every
 * other leaf as `other` does: a reader passed to `textBetween` wins over the
 * node's own `leafText` (`prosemirror-model` 1.25.12 `index.js:122-123`).
 * @param other - What any other leaf reads as.
 * @returns The reader.
 */
export function leafWords(other: (leaf: PMNode) => string): (leaf: PMNode) => string {
  return (leaf) => (isFormula(leaf) ? formulaLeafText(leaf) : other(leaf));
}

/**
 * Whether a node is a formula with a source, which counts as content for the
 * Agent and the bubble bar.
 * @param node - The node.
 * @returns True for a formula whose source is not empty.
 */
export function holdsFormula(node: PMNode): boolean {
  return isFormula(node) && formulaSource(node) !== '';
}

/** Gives both formula nodes their text, which `textContent` and `textBetween` read. */
const FormulaText = Extension.create({
  name: 'documentFormulaText',
  extendNodeSchema: (extension) =>
    extension.name === MATH_BLOCK || extension.name === MATH_INLINE ? { leafText: formulaLeafText } : {},
});

/** The box's element: a control region of its own (design 5.1). */
export const FORMULA_BOX = '[data-formula-box]';

/** The attribute on a formula node view's own element. */
const FORMULA_HOST = 'data-formula-host';

/** Where the caret goes in the source when the box opens. */
type Caret = 'start' | 'end';

/**
 * Where the body's selection goes when the box closes: right before or after
 * an inline formula, onto a block formula whole, to the line above or below a
 * block formula, or nowhere because the press that closed it took the
 * keyboard elsewhere.
 */
type Leave = 'before' | 'after' | 'above' | 'below' | 'stay';

/** What a formula's face shows. */
interface FaceState {
  readonly source: string;
  readonly open: boolean;
  readonly caret: Caret;
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
      if ((Object.keys(patch) as (keyof FaceState)[]).every((key) => patch[key] === state[key])) return;
      state = { ...state, ...patch };
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
 * One rendered formula.
 * @param props - The preview.
 * @param props.html - KaTeX's markup.
 * @param props.className - Extra classes.
 * @returns The preview.
 */
function FormulaMarkup({ html, className }: { html: string; className?: string }): React.JSX.Element {
  // KaTeX's output for a source in our document: with `trust: false` it
  // writes formula elements only (design §6.1).
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** What the face asks of its node view. */
interface FaceActions {
  readonly open: (caret: Caret, press?: boolean) => void;
  readonly close: (leave: Leave) => void;
  readonly write: (source: string) => void;
  readonly remove: (back: boolean) => void;
  readonly history: (redo: boolean) => void;
  readonly focused: (inside: boolean) => void;
}

/**
 * What a key in the box does, before the text field's own handling.
 * @param event - The key.
 * @param field - The text field.
 * @param inline - Whether the formula sits inside a line.
 * @param actions - The node view's actions.
 * @param ended - The field's composition ends.
 * @returns Whether the key was taken.
 */
function boxKey(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  field: HTMLTextAreaElement,
  inline: boolean,
  actions: FaceActions,
  ended: CompositionEnd,
): boolean {
  if (keyBelongsToInputMethod(event.nativeEvent, ended)) return false;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (mod && !event.altKey && (key === 'z' || (key === 'y' && event.ctrlKey && !event.metaKey))) {
    actions.history(key === 'y' || event.shiftKey);
    return true;
  }
  if (event.key === 'Escape' || (event.key === 'Enter' && (inline || !event.shiftKey))) {
    actions.close('after');
    return true;
  }
  const { selectionStart: from, selectionEnd: to, value } = field;
  if ((event.key === 'Backspace' || event.key === 'Delete') && value === '') {
    actions.remove(event.key === 'Backspace');
    return true;
  }
  if (event.shiftKey || mod || event.altKey || from !== to) return false;
  if (event.key === 'ArrowLeft' && inline && from === 0) actions.close('before');
  else if (event.key === 'ArrowRight' && inline && from === value.length) actions.close('after');
  else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && inline) actions.close('after');
  else if (event.key === 'ArrowUp' && from === 0) actions.close('above');
  else if (event.key === 'ArrowDown' && from === value.length) actions.close('below');
  else return false;
  return true;
}

/**
 * Clips a fixed box to a scroller's rectangle, its shadow included, so only
 * the part over the scroller shows, and clips it whole while `hide()` finds
 * its formula out of sight: a clipped box keeps the focus, which
 * `visibility: hidden` would take, and closing the box with it. Placed last,
 * after `hide()`, it reads the box's final place.
 * @param scroller - The scroller.
 * @returns The middleware.
 */
function clipTo(scroller: HTMLElement): Middleware {
  return {
    name: 'clipTo',
    fn: ({ x, y, rects, elements, middlewareData }) => {
      const room = scroller.getBoundingClientRect();
      const { width, height } = rects.floating;
      const inset = [room.top - y, x + width - room.right, y + height - room.bottom, room.left - x];
      elements.floating.style.clipPath = middlewareData.hide?.referenceHidden === true
        ? 'inset(50%)'
        : `inset(${inset.map((side) => `${side}px`).join(' ')})`;
      return {};
    },
  };
}

/**
 * The rendered formula with its source box: what a formula looks like in the
 * body, and the box it is edited in.
 * @param props - The face.
 * @param props.store - The node view's state.
 * @param props.actions - What the face asks of its node view.
 * @param props.inline - Whether the formula sits inside a line.
 * @param props.host - The node view's element, to tell whether it sits in a table cell.
 * @returns The face.
 */
const MathFace = React.memo(function MathFace({
  store,
  actions,
  inline,
  host,
}: {
  store: FaceStore;
  actions: FaceActions;
  inline: boolean;
  host: HTMLElement;
}): React.JSX.Element {
  const t = useTranslation();
  const { source, open, caret, selected, editable } = React.useSyncExternalStore(store.subscribe, store.get);
  const shown = open && editable;
  // KaTeX draws nothing for white space: such a source shows the placeholder.
  const blank = source.trim() === '';
  const rendered = React.useMemo(() => (blank ? null : renderFormula(source, !inline)), [blank, source, inline]);
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

  // The field holds what is being typed, so an input method's composition
  // stays the field's until it ends; the source catches up from the node
  // whenever nothing is being composed.
  const field = React.useRef<HTMLTextAreaElement | null>(null);
  const composing = React.useRef(false);
  const ended = React.useMemo(compositionEnd, []);
  const [draft, setDraft] = React.useState(source);
  React.useEffect(() => {
    if (!composing.current) setDraft(source);
  }, [source]);
  React.useLayoutEffect(() => {
    const element = field.current;
    if (!shown || element === null) return;
    element.focus({ preventScroll: true });
    const at = caret === 'start' ? 0 : element.value.length;
    element.setSelectionRange(at, at);
  }, [shown, caret]);

  const inCell = React.useMemo(() => host.closest(`[data-node-type='${DOC_TABLE}']`) !== null, [host]);
  // The body's own scroller: a table cell sits inside the table's sideways
  // scroller too, and the box belongs to the window's room, not the table's.
  const viewport = React.useMemo(
    () => host.closest<HTMLElement>(`.${BODY_SCROLLER_CLASS} > [data-radix-scroll-area-viewport]`) ?? undefined,
    [host],
  );
  // Below the formula, or above it when the window has no room below; the
  // side is settled as the box appears, so a growing error line does not
  // flip it (as the AI custom-request box, `DocumentAiDialog.tsx`).
  const [side, setSide] = React.useState<Placement | null>(null);
  const middleware = React.useMemo(
    () => [
      offset(4),
      ...(side === null ? [flip({ boundary: viewport })] : []),
      shift({ boundary: viewport, padding: 8 }),
      // A body column narrower than the box narrows the box to the column.
      size({
        boundary: viewport,
        padding: 8,
        apply: ({ availableWidth, elements }) => {
          elements.floating.style.maxWidth = `${availableWidth}px`;
        },
      }),
      // A box in a cell sits outside the body's clip, so it is clipped to the
      // body here, and away once its formula is out of sight, as a box under
      // a paragraph formula is by the body itself.
      ...(inCell && viewport !== undefined ? [hide(), clipTo(viewport)] : []),
    ],
    [side, viewport, inCell],
  );
  const { refs, floatingStyles, placement, isPositioned } = useFloating({
    open: shown,
    placement: side ?? (inline ? 'bottom-start' : 'bottom'),
    strategy: inCell ? 'fixed' : 'absolute',
    middleware,
    whileElementsMounted: shown ? autoUpdate : undefined,
  });
  React.useEffect(() => {
    if (!shown) setSide(null);
    else if (isPositioned && side === null) setSide(placement);
  }, [shown, isPositioned, placement, side]);

  const Wrapper = inline ? 'span' : 'div';
  const face =
    blank ? (
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
      ref={refs.setReference}
      className='doc-math'
      data-open={shown ? 'true' : 'false'}
      data-selected={!inline && selected && editable && !shown ? 'true' : undefined}
    >
      <Wrapper
        className={cn(!editable && 'cursor-default')}
        role={editable && preview === null ? 'button' : undefined}
        // The body keeps the keyboard until the box takes it.
        onMouseDown={(event) => {
          if (!editable) return;
          event.preventDefault();
          event.stopPropagation();
          actions.open('end', true);
        }}
      >
        {inline ? (
          face
        ) : (
          // A formula wider than the body scrolls sideways in its own
          // scroller, as a formula in a chat reply does (`MarkdownMessage.tsx`);
          // the frame a selection draws sits around that scroller.
          <div data-math-frame className='mx-auto w-fit max-w-full'>
            <ScrollArea scrollbars='horizontal' className={cn('w-full', DISPLAY_MATH_SCROLLER)}>
              <div className='flex w-max min-w-full flex-col items-center'>{face}</div>
            </ScrollArea>
          </div>
        )}
      </Wrapper>
      {shown && (
        <div
          ref={refs.setFloating}
          data-formula-box
          style={floatingStyles}
          className='z-20 flex w-[min(560px,calc(100vw-2rem))] flex-col rounded-overlay border border-border bg-popover text-left text-popover-foreground shadow-md'
          onFocus={() => {
            actions.focused(true);
          }}
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            actions.focused(false);
            // A switch to another window lands on the formula, as Escape does,
            // so the keyboard is in the body when the window comes back.
            const windowLeft = event.relatedTarget === null && !event.currentTarget.ownerDocument.hasFocus();
            actions.close(windowLeft ? 'after' : 'stay');
          }}
        >
          <div className='flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-sm font-medium'>
            <Sigma className='h-3.5 w-3.5 shrink-0 text-muted-foreground' aria-hidden />
            <span className='truncate'>{t('spaces.document.commands.formula')}</span>
          </div>
          <div className='p-3'>
            <Textarea
              ref={field}
              value={draft}
              spellCheck={false}
              placeholder={t('spaces.document.math.placeholder')}
              className='min-h-[calc(3lh+1rem+2px)] resize-none whitespace-pre-wrap break-all font-mono md:text-sm'
              onChange={(event) => {
                setDraft(event.target.value);
                if (!composing.current) actions.write(event.target.value);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                ended.mark();
                actions.write(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (boxKey(event, event.currentTarget, inline, actions, ended)) event.preventDefault();
              }}
            />
            {error !== null && <p className='mt-1.5 text-xs text-status-error-foreground'>{error}</p>}
          </div>
          <div className='flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-1.5'>
            <Button
              size='sm'
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                actions.close('after');
              }}
            >
              {t('spaces.document.math.ok')}
            </Button>
          </div>
        </div>
      )}
    </Wrapper>
  );
});

/** Opens a formula's box from outside its node view, keyed by the view's element. */
const openers = new WeakMap<HTMLElement,(caret: Caret) => void>();

/**
 * Opens the box of the formula at a position, as a click on it does.
 * @param view - The editor view.
 * @param pos - Where the `math` or `mathBlock` node starts.
 * @param caret - Where the caret goes in the source.
 * @returns Whether a formula's box was there to open.
 */
export function openFormulaAt(view: EditorView, pos: number, caret: Caret): boolean {
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return false;
  const host = dom.hasAttribute(FORMULA_HOST) ? dom : dom.querySelector<HTMLElement>(`[${FORMULA_HOST}]`);
  const open = host === null ? undefined : openers.get(host);
  if (open === undefined) return false;
  open(caret);
  return true;
}

/** What opening a block formula's box needs of the editor. */
type BoxOpener = Pick<AnyEditor, 'prosemirrorView'>;

/**
 * Opens a block formula's box, as a click on it does.
 * @param editor - The editor.
 * @param id - The formula block's id.
 * @returns Whether the box opened.
 */
export function openFormulaBlock(editor: BoxOpener, id: string): boolean {
  const view = editor.prosemirrorView;
  if (view === undefined) return false;
  const found = getNodeById(id, view.state.doc);
  return found?.node.firstChild?.type.name === MATH_BLOCK && openFormulaAt(view, found.posBeforeNode + 1, 'end');
}

/**
 * Removes a block formula, the lines indented under it lifted into its place,
 * as an empty paragraph's Backspace does; the caret goes to the end of what
 * came before it for Backspace, to the start of what follows for Delete,
 * inside its table cell when it is in one.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param pos - Where the `mathBlock` node starts.
 * @param back - Backspace, else Delete.
 */
export function removeFormulaBlock(editor: AnyEditor, view: EditorView, pos: number, back: boolean): void {
  const $pos = view.state.doc.resolve(pos);
  const at = $pos.before();
  const id = $pos.parent.attrs['id'] as string;
  // The cell's start lies before the formula, so the removal leaves it where it is.
  const cell = cellDepthOf($pos);
  const cellStart = cell < 0 ? -1 : $pos.start(cell);
  const children = (editor.getBlock(id) as { children: never[] } | undefined)?.children ?? [];
  if (children.length > 0) editor.replaceBlocks([id], children);
  else editor.removeBlocks([id]);
  const { state } = view;
  const $at = state.doc.resolve(Math.min(at, state.doc.content.size));
  let near = Selection.near($at, back ? -1 : 1);
  if (cellStart >= 0) {
    const $cell = state.doc.resolve(cellStart);
    if (near.from < cellStart || near.from > $cell.end()) near = Selection.near($at, back ? 1 : -1);
  }
  view.dispatch(state.tr.setSelection(near));
}

/** A node view as ProseMirror takes it. */
interface FormulaView {
  dom: HTMLElement;
  update: (node: PMNode) => boolean;
  selectNode: () => void;
  deselectNode: () => void;
  stopEvent: (event: Event) => boolean;
  ignoreMutation: () => boolean;
  destroy: () => void;
}

/**
 * Mounts a formula's face and box.
 * @param inline - Whether the formula sits inside a line.
 * @param initial - The node the view starts with.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param getPos - Where the node starts now.
 * @returns The node view.
 */
function mountFormula(
  inline: boolean,
  initial: PMNode,
  editor: AnyEditor,
  view: EditorView,
  getPos: () => number | undefined,
): FormulaView {
  const dom = document.createElement(inline ? 'span' : 'div');
  dom.setAttribute(FORMULA_HOST, '');
  // A block formula spans its line, which BlockNote lays out as a flex row.
  if (!inline) dom.className = 'w-full min-w-0';
  let node = initial;
  let boxHasFocus = false;
  const readOnly = editor.getExtension(ReadOnlyExtension)!;
  const store = faceStore({
    source: formulaSource(node),
    open: false,
    caret: 'end',
    selected: false,
    editable: editor.isEditable,
  });
  /**
   * Puts the keyboard back in the body with the selection given.
   * @param selection - The selection, or null to keep the one there is.
   */
  const toBody = (selection: Selection | null): void => {
    if (selection !== null) view.dispatch(view.state.tr.setSelection(selection));
    view.focus();
  };
  const actions: FaceActions = {
    open: (caret, press = false) => {
      if (!editor.isEditable) return;
      const pos = getPos();
      // A press leaves the body's selection wherever it was; it goes on the
      // formula first, so an undo of the edit comes back to the formula.
      if (press && pos !== undefined) {
        const { doc } = view.state;
        view.dispatch(view.state.tr.setSelection(inline ? TextSelection.create(doc, pos + node.nodeSize) : NodeSelection.create(doc, pos)));
      }
      store.set({ open: true, caret });
    },
    close: (leave) => {
      store.set({ open: false });
      const pos = getPos();
      if (leave === 'stay' || pos === undefined) return;
      const { doc } = view.state;
      if (inline) {
        toBody(TextSelection.create(doc, leave === 'before' ? pos : pos + node.nodeSize));
        return;
      }
      const container = doc.resolve(pos).before();
      const end = container + doc.resolve(pos).parent.nodeSize;
      if (leave === 'above') toBody(Selection.near(doc.resolve(container), -1));
      else if (leave === 'below') toBody(Selection.near(doc.resolve(Math.min(end, doc.content.size)), 1));
      else toBody(NodeSelection.create(doc, pos));
    },
    write: (source) => {
      const pos = getPos();
      if (pos === undefined || !editor.isEditable || source === formulaSource(node)) return;
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, source }));
    },
    remove: (back) => {
      const pos = getPos();
      if (pos === undefined || !editor.isEditable) return;
      store.set({ open: false });
      // The text field goes with the formula; the keyboard stays with the body.
      view.focus();
      if (!inline) {
        removeFormulaBlock(editor, view, pos, back);
        return;
      }
      const tr = view.state.tr.delete(pos, pos + node.nodeSize);
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos)));
    },
    history: (redo) => {
      if (redo) editor.redo();
      else editor.undo();
    },
    focused: (inside) => {
      boxHasFocus = inside;
    },
  };
  /** Copies whether the body can be edited onto the face, closing the box when it cannot. */
  const syncEditable = (): void => {
    const editable = editor.isEditable;
    store.set(editable ? { editable } : { editable, open: false });
  };
  const stopReadOnly = readOnly.store.subscribe(syncEditable);
  openers.set(dom, actions.open);
  const root: Root = createRoot(dom);
  root.render(<MathFace store={store} actions={actions} inline={inline} host={dom} />);
  return {
    dom,
    update: (next) => {
      if (next.type !== node.type) return false;
      node = next;
      store.set({ source: formulaSource(next) });
      return true;
    },
    selectNode: () => {
      store.set({ selected: true });
    },
    deselectNode: () => {
      store.set({ selected: false });
    },
    stopEvent: (event) => event.target instanceof Element && event.target.closest(FORMULA_BOX) !== null,
    // What React draws inside is not the document's; the node has no content.
    ignoreMutation: () => true,
    destroy: () => {
      stopReadOnly();
      openers.delete(dom);
      // An undo or a co-editor that takes the formula away takes the focused
      // text field with it; the keyboard goes back to the body. ProseMirror
      // destroys the view before it takes the element out, so the field can
      // still hold the keyboard here.
      const active = dom.ownerDocument.activeElement;
      if (boxHasFocus && (active === null || active === dom.ownerDocument.body || dom.contains(active))) view.focus();
      // React refuses a synchronous unmount while it is rendering, and
      // ProseMirror can tear views down from inside a React commit.
      queueMicrotask(() => {
        root.unmount();
      });
    },
  };
}

/**
 * A static copy of a formula for BlockNote's own HTML: the source in the
 * attribute our parse reads back, and as its words the `$$` text.
 * @param source - The LaTeX.
 * @param block - Whether the formula stands on a line of its own.
 * @returns The element.
 */
function staticFormula(source: string, block: boolean): { dom: HTMLElement } {
  return { dom: formulaSourceHolder(source, block) };
}

/** What `render` sees as `this`: a node view hands it its ProseMirror props. */
type RenderContext =
  | {
      readonly renderType: 'nodeView';
      readonly props: { readonly node: PMNode; readonly view: EditorView; readonly getPos: () => number | undefined };
    }
  | { readonly renderType?: 'dom'; readonly props?: undefined };

/** A formula as `render` and the exporters receive it. */
interface FormulaBlock {
  readonly props: { readonly source: string };
}

/** Gives both formula nodes their text; registered with the block spec, so every editor built from the schema has it. */
const formulaTextExtension = createExtension({ key: 'document-formula-text', tiptapExtensions: [FormulaText] });

/**
 * The block formula.
 * @returns The block spec.
 */
export function mathBlockSpec(): unknown {
  return createBlockSpec(
    {
      type: MATH_BLOCK,
      propSchema: { quoted: { default: false }, source: { default: '' } },
      content: 'none',
    },
    {
      parse: (element: HTMLElement) =>
        isBlockFormula(element) ? { source: sourceOf(element, MATH_BLOCK_SOURCE_ATTR) } : undefined,
      render(this: RenderContext, block: FormulaBlock, editor: AnyEditor) {
        if (this.renderType !== 'nodeView') return staticFormula(block.props.source, true);
        const { node, view, getPos } = this.props;
        return mountFormula(false, node, editor, view, getPos);
      },
      toExternalHTML: (block: FormulaBlock) => ({ dom: externalFormula(block.props.source, true) }),
    } as never,
    [formulaTextExtension],
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
    { type: MATH_INLINE, propSchema: { source: { default: '' } }, content: 'none' },
    {
      parse: (element: HTMLElement) =>
        isInlineFormula(element) ? { source: sourceOf(element, MATH_SOURCE_ATTR) } : undefined,
      render(this: RenderContext, ...[inlineContent, , editor, node, getPos]: InlineRenderArgs) {
        const view = editor.prosemirrorView;
        if (this.renderType !== 'nodeView' || getPos === undefined || node === undefined || view === undefined) {
          return staticFormula(inlineContent.props.source, false);
        }
        return mountFormula(true, node, editor, view, getPos);
      },
      toExternalHTML: (inlineContent: FormulaBlock) => ({ dom: externalFormula(inlineContent.props.source, false) }),
    } as never,
  );
}
