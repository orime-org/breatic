// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pasted HTML made ready for the body to read (inner#1351 + inner#1390 design
 * §5.4), on every way it comes in: an HTML paste, a Markdown paste carrying
 * media, and a drop.
 *
 * BlockNote reads a medium into a block only where a block can stand, and
 * reads a picture's address from its `src` alone (`parseImageElement.ts`);
 * a figure is read as one medium, its first. So before the HTML is read, its
 * media are put where a block stands, each in its own place: one in a table
 * cell under the table (A7), one in a line of text between the two halves of
 * that line, the media of a figure holding several each on its own. A
 * picture's address is the one a browser shows from its `srcset`, when it
 * can be fetched. Whatever a read still loses is counted with what the paste
 * left out, so no medium goes without the reader being told.
 */

import { markdownToHTML } from '@blocknote/core';

import { routeAddress } from '@web/spaces/document/document-canvas-paste';
import type { BlockSpec, PasteHandler } from '@web/spaces/document/document-file-input';
import { HTML_MEDIA_ELEMENTS, HTML_MEDIA_SELECTOR, isMediaBlockType } from '@web/spaces/document/document-media-types';
import { evenTables } from '@web/spaces/document/document-table-paste';

/** The key the pasted-media extension registers under. */
export const PASTED_MEDIA_KEY = 'documentPastedMedia';

/** What a paste hook tells the pasted-media extension. */
export interface PasteLossSink {
  /** Counts media a read lost with what the paste left out. */
  leaveOut(count: number): void;
}

/** Whether a piece of HTML carries an image, a video or an audio. */
export const HTML_MEDIA = new RegExp(`<(${HTML_MEDIA_ELEMENTS.join('|')})\\b`, 'i');

/** The blocks of text a medium can stand in the middle of. */
const TEXT_BLOCKS = 'p, h1, h2, h3, h4, h5, h6';

/** A block as BlockNote reads it out of HTML. */
export interface ReadBlock extends BlockSpec {
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly ReadBlock[];
}

/**
 * Every medium among blocks, nested ones too, in document order.
 * @param blocks - The blocks.
 * @returns The media.
 */
export function mediaIn(blocks: readonly ReadBlock[]): ReadBlock[] {
  return blocks.flatMap((block) => [...(isMediaBlockType(block.type) ? [block] : []), ...mediaIn(block.children)]);
}

/**
 * How many media elements a piece of HTML holds.
 * @param html - The HTML.
 * @returns The count.
 */
export function mediaElementCount(html: string): number {
  if (!HTML_MEDIA.test(html)) return 0;
  return new DOMParser().parseFromString(html, 'text/html').body.querySelectorAll(HTML_MEDIA_SELECTOR).length;
}

/** One image candidate of a `srcset`. */
interface Candidate {
  readonly url: string;
  readonly width?: number;
  readonly density?: number;
}

/**
 * The image candidates of a `srcset`, read the way HTML reads them ("parse a
 * srcset attribute"): an address runs to the first space, a comma that ends
 * it belongs to no address, and a comma outside parentheses ends a
 * candidate's descriptors. A candidate with descriptors HTML does not take is
 * dropped.
 * @param srcset - The attribute.
 * @returns The candidates, in order.
 */
export function srcsetCandidates(srcset: string): Candidate[] {
  const out: Candidate[] = [];
  let at = 0;
  while (at < srcset.length) {
    while (at < srcset.length && /[\s,]/.test(srcset[at]!)) at += 1;
    if (at >= srcset.length) break;
    const start = at;
    while (at < srcset.length && !/\s/.test(srcset[at]!)) at += 1;
    let url = srcset.slice(start, at);
    const descriptors: string[] = [];
    if (/,$/.test(url)) {
      url = url.replace(/,+$/, '');
    } else {
      let token = '';
      let inParens = false;
      while (at < srcset.length) {
        const char = srcset[at]!;
        at += 1;
        if (!inParens && char === ',') break;
        if (!inParens && /\s/.test(char)) {
          if (token !== '') descriptors.push(token);
          token = '';
          continue;
        }
        if (char === '(') inParens = true;
        if (char === ')') inParens = false;
        token += char;
      }
      if (token !== '') descriptors.push(token);
    }
    const candidate = withDescriptors(url, descriptors);
    if (url !== '' && candidate !== null) out.push(candidate);
  }
  return out;
}

/**
 * A candidate with its descriptors read, or null when HTML would not take it.
 * @param url - Its address.
 * @param descriptors - Its descriptor tokens.
 * @returns The candidate, or null.
 */
function withDescriptors(url: string, descriptors: readonly string[]): Candidate | null {
  let width: number | undefined;
  let density: number | undefined;
  for (const descriptor of descriptors) {
    const w = /^(\d+)w$/.exec(descriptor);
    const x = /^(\d*\.?\d+(?:e[+-]?\d+)?)x$/i.exec(descriptor);
    if (w !== null && width === undefined && density === undefined) width = Number(w[1]);
    else if (x !== null && width === undefined && density === undefined) density = Number(x[1]);
    else if (!/^\d+h$/.test(descriptor)) return null;
  }
  return { url, ...(width !== undefined && { width }), ...(density !== undefined && { density }) };
}

/**
 * The address of the largest candidate of a `srcset` that can be fetched:
 * the widest, or else the densest. A browser picks by the width it shows the
 * picture at and the screen's density, neither of which a clipboard carries;
 * the largest is never worse than the one the reader saw.
 * @param srcset - The attribute.
 * @returns The address, or null when no candidate can be fetched.
 */
function largestCandidate(srcset: string): string | null {
  const fetchable = srcsetCandidates(srcset).filter((candidate) => routeAddress(candidate.url) !== 'skip');
  const widths = fetchable.filter((candidate) => candidate.width !== undefined);
  const pool = widths.length > 0 ? widths : fetchable;
  /**
   * How large a candidate is: its width, else its density, else 1x.
   * @param candidate - The candidate.
   * @returns The size.
   */
  const size = (candidate: Candidate): number => candidate.width ?? candidate.density ?? 1;
  const largest = pool.reduce<Candidate | null>((best, candidate) => (best === null || size(candidate) > size(best) ? candidate : best), null);
  return largest?.url ?? null;
}

/**
 * Moves the media a table cell holds right after the outermost table around
 * them — after the figure around that table, when there is one, which would
 * otherwise be read as a captioned picture — in the order they came in. A
 * medium moves with the figure around it when that figure is in the cell too.
 * @param root - The HTML's body.
 * @returns Whether anything moved.
 */
function liftCellMedia(root: Element): boolean {
  const last = new Map<Element, Element>();
  for (const element of Array.from(root.querySelectorAll(HTML_MEDIA_SELECTOR))) {
    // Gone from its cell with a figure moved before it.
    const cell = element.closest('td, th');
    if (cell === null) continue;
    // A td in an SVG is no table cell.
    let table = cell.closest('table');
    if (table === null) continue;
    for (let outer = table.parentElement?.closest('table'); outer; outer = outer.parentElement?.closest('table')) {
      table = outer;
    }
    const anchor = table.closest('figure') ?? table;
    const figure = element.closest('figure');
    const carried = figure !== null && cell.contains(figure) ? figure : element;
    (last.get(anchor) ?? anchor).after(carried);
    last.set(anchor, carried);
  }
  return last.size > 0;
}

/**
 * Takes apart every figure holding more than one medium, outermost first, so
 * each medium is read on its own, with the figure around it when it has one.
 * @param root - The HTML's body.
 * @returns Whether any figure was taken apart.
 */
function unwrapCrowdedFigures(root: Element): boolean {
  let changed = false;
  for (;;) {
    const crowded = Array.from(root.querySelectorAll('figure')).find(
      (figure) => figure.querySelectorAll(HTML_MEDIA_SELECTOR).length > 1,
    );
    if (crowded === undefined) return changed;
    crowded.replaceWith(...Array.from(crowded.childNodes));
    changed = true;
  }
}

/**
 * Whether a block left by a split holds nothing to read.
 * @param block - The block.
 * @returns True when it has no words and no medium.
 */
function holdsNothing(block: Element): boolean {
  return (block.textContent ?? '').trim() === '' && block.querySelector(HTML_MEDIA_SELECTOR) === null;
}

/**
 * Splits every line of text a medium stands in at the medium, so the medium
 * is read between the two halves; a half with no words goes.
 * @param root - The HTML's body.
 * @returns Whether any line was split.
 */
function splitTextAroundMedia(root: Element): boolean {
  let changed = false;
  for (const element of Array.from(root.querySelectorAll(HTML_MEDIA_SELECTOR))) {
    const block = element.parentElement?.closest(TEXT_BLOCKS);
    if (block === null || block === undefined) continue;
    const picture = element.closest('picture');
    const carried = picture !== null && block.contains(picture) ? picture : element;
    const before = block.ownerDocument.createRange();
    before.setStart(block, 0);
    before.setEndBefore(carried);
    const head = block.cloneNode(false) as Element;
    head.append(before.extractContents());
    block.before(head, carried);
    for (const part of [head, block]) if (holdsNothing(part)) part.remove();
    changed = true;
  }
  return changed;
}

/**
 * Gives every picture with a `srcset` the address a browser shows, when one
 * of its candidates can be fetched.
 * @param root - The HTML's body.
 * @returns Whether any address changed.
 */
function readPictureAddresses(root: Element): boolean {
  let changed = false;
  for (const image of Array.from(root.querySelectorAll('img[srcset]'))) {
    const url = largestCandidate(image.getAttribute('srcset') ?? '');
    if (url !== null && url !== image.getAttribute('src')) {
      image.setAttribute('src', url);
      changed = true;
    }
  }
  return changed;
}

/**
 * Pasted HTML ready to read: its tables evened and its media where a block
 * stands, each picture with the address a browser shows.
 * @param html - The HTML.
 * @returns The same HTML when nothing needed doing, the ready HTML otherwise.
 */
export function preparePastedHTML(html: string): string {
  if (!/<table\b/i.test(html) && !HTML_MEDIA.test(html)) return html;
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const steps = [evenTables, liftCellMedia, unwrapCrowdedFigures, splitTextAroundMedia, readPictureAddresses];
  const changed = steps.map((step) => step(body)).some(Boolean);
  return changed ? body.innerHTML : html;
}

/**
 * The HTML a paste brings: its clipboard's HTML, or the HTML a Markdown or
 * plain-text paste carrying media becomes, the way BlockNote reads it
 * (`pasteExtension.ts`, `parseMarkdown.ts`). The body's own clipboard and
 * an editor's code are left to BlockNote.
 * @param data - The clipboard.
 * @returns The HTML, or '' when the paste brings none to prepare.
 */
function pastedHTML(data: DataTransfer): string {
  const html = data.getData('text/html');
  if (html !== '') return html;
  if (data.types.includes('blocknote/html') || data.types.includes('vscode-editor-data')) return '';
  const markdown = data.getData('text/markdown') || data.getData('text/plain');
  if (markdown === '') return '';
  const converted = markdownToHTML(markdown);
  return HTML_MEDIA.test(converted) ? converted : '';
}

/**
 * BlockNote's own paste, given the paste's HTML made ready to read, with the
 * media BlockNote's read loses counted as left out. A paste into code is
 * read as plain text and left as it is.
 * @param context - What BlockNote hands the paste hook.
 * @param context.event - The paste.
 * @param context.editor - The editor.
 * @param context.defaultPasteHandler - BlockNote's own paste.
 * @returns Whether the paste was handled.
 */
export const documentPasteHandler: PasteHandler = ({ event, editor, defaultPasteHandler }) => {
  const data = event.clipboardData;
  const view = editor.prosemirrorView;
  if (data === null || view === undefined || view === null || view.state.selection.$from.parent.type.spec.code === true) {
    return defaultPasteHandler();
  }
  const source = pastedHTML(data);
  const prepared = preparePastedHTML(source);
  if (prepared !== data.getData('text/html')) {
    const preparedData: Pick<DataTransfer, 'types' | 'files' | 'items' | 'getData'> = {
      types: data.types.includes('text/html') ? data.types : [...data.types, 'text/html'],
      files: data.files,
      items: data.items,
      getData: (format: string): string => (format === 'text/html' ? prepared : data.getData(format)),
    };
    Object.defineProperty(event, 'clipboardData', { value: preparedData });
  }
  const expected = mediaElementCount(prepared);
  if (expected > 0) {
    const read = mediaIn(editor.tryParseHTMLToBlocks(prepared) as unknown as ReadBlock[]).length;
    (editor.getExtension(PASTED_MEDIA_KEY) as PasteLossSink | undefined)?.leaveOut(expected - read);
  }
  // HTML carrying media is read as HTML even when its plain text looks like
  // Markdown, which would drop every picture (inner#1351 design §5.1).
  return expected > 0 ? defaultPasteHandler({ prioritizeMarkdownOverHTML: false }) : defaultPasteHandler();
};
