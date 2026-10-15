// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pasted HTML made ready for the body to read (inner#1351 + inner#1390 design
 * §5.4), on every way it comes in: an HTML paste, a Markdown paste and a
 * drop.
 *
 * BlockNote reads a medium into a block only where a block can stand, and
 * reads a picture's address from its `src` alone (`parseImageElement.ts`);
 * a figure is read as its first medium and its first caption, and nothing
 * else in it (`parseFigureElement`). So before the HTML is read, its media
 * are put where a block stands, each in its own place: one in a table cell
 * under the table (A7), one in a line of text between the two halves of that
 * line, the media of a figure holding several each on its own, and what else
 * a figure holds beside it. A picture's address is the largest candidate of
 * its `srcset` that can be fetched. A medium that does not land is taken out
 * before the read, so its line reads whole. What was taken out and whatever
 * a read still loses are counted with what the paste left out, so no medium
 * goes without the reader being told.
 *
 * A paste BlockNote's own paste (`pasteExtension.ts`) would read as Markdown,
 * or as HTML carrying media, is read here: made ready, read once, counted
 * from that read and put in. Every other paste is BlockNote's own, given the
 * clipboard's HTML with its tables evened.
 */

import { isMarkdown, markdownToHTML } from '@blocknote/core';

import { routeAddress } from '@web/spaces/document/document-media-address';
import { inTableCell, type BlockSpec, type PasteHandler } from '@web/spaces/document/document-file-input';
import {
  HTML_MEDIA_ELEMENTS,
  HTML_MEDIA_SELECTOR,
  MEDIA_BLOCK_TYPES,
  isMediaBlockType,
} from '@web/spaces/document/document-media-types';
import { evenTables } from '@web/spaces/document/document-table-paste';

/** The key the pasted-media extension registers under. */
export const PASTED_MEDIA_KEY = 'documentPastedMedia';

/** What a paste hook asks of the pasted-media extension. */
interface PastedMedia {
  /** Counts media a read lost with what the paste left out. */
  leaveOut(count: number): void;
  /** Whether a medium at an address lands in the body. */
  lands(url: string): boolean;
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
 * Whether blocks hold a table, nested ones too: words a table cell cannot take.
 * @param blocks - The blocks.
 * @returns True when one of them is a table.
 */
export function holdsTable(blocks: readonly ReadBlock[]): boolean {
  return blocks.some((block) => block.type === 'table' || holdsTable(block.children));
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
    if (url.endsWith(',')) {
      while (url.endsWith(',')) url = url.slice(0, -1);
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

/** A valid non-negative floating-point number, as HTML writes one. */
const FLOAT = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A valid non-negative integer. */
const INTEGER = /^\d+$/;

/**
 * A candidate with its descriptors read the way HTML reads them, or null when
 * HTML would drop it: a width and a height are positive integers, a density
 * is a non-negative number, a candidate has a width or a density but not
 * both, and a height only beside a width.
 * @param url - Its address.
 * @param descriptors - Its descriptor tokens.
 * @returns The candidate, or null.
 */
function withDescriptors(url: string, descriptors: readonly string[]): Candidate | null {
  let width: number | undefined;
  let density: number | undefined;
  let height: number | undefined;
  for (const descriptor of descriptors) {
    const value = descriptor.slice(0, -1);
    const unit = descriptor.slice(-1);
    if (unit === 'w' && INTEGER.test(value) && Number(value) > 0 && width === undefined && density === undefined) {
      width = Number(value);
    } else if (unit === 'x' && FLOAT.test(value) && width === undefined && density === undefined) {
      density = Number(value);
    } else if (unit === 'h' && INTEGER.test(value) && Number(value) > 0 && height === undefined && density === undefined) {
      height = Number(value);
    } else {
      return null;
    }
  }
  if (height !== undefined && width === undefined) return null;
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
 * Whether a block left by a split holds nothing to read.
 * @param block - The block.
 * @returns True when it has no words and no medium.
 */
function holdsNothing(block: Element): boolean {
  return (block.textContent ?? '').trim() === '' && block.querySelector(HTML_MEDIA_SELECTOR) === null;
}

/**
 * Takes the line breaks and the white space off one end of a part a medium
 * was split from, wherever they sit inside it, up to the first words or
 * medium; the white space at the edge of those words goes too.
 * @param part - The part.
 * @param end - Which end: the start of the part after the medium, the end of
 *   the part before it.
 */
function trimBreaks(part: Element | DocumentFragment, end: 'start' | 'end'): void {
  const walker = part.ownerDocument.createTreeWalker(part, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node);
  if (end === 'end') nodes.reverse();
  for (const node of nodes) {
    if (node.nodeName === 'BR' || (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '')) {
      node.parentNode?.removeChild(node);
    } else if (node.nodeType === Node.TEXT_NODE) {
      node.textContent = (node.textContent ?? '').replace(end === 'end' ? /\s+$/ : /^\s+/, '');
      return;
    } else if (node instanceof Element && node.matches(HTML_MEDIA_SELECTOR)) {
      return;
    }
  }
}

/**
 * Takes the copy of a medium's ancestors a part was left with off it when
 * that copy holds nothing: `Range.extractContents` copies every ancestor it
 * cuts through into the part, and an empty heading or list item copied that
 * way would be read as a line of its own. Only the outermost empty copy goes.
 * @param part - The part.
 * @param depth - How many ancestors the medium had inside the container.
 * @param end - Which end of the part the copies run along.
 */
function dropEmptyCopy(part: DocumentFragment, depth: number, end: 'start' | 'end'): void {
  /**
   * The next copy in from a node, along the end the copies run along.
   * @param node - The node.
   * @returns The child element at that end.
   */
  const next = (node: ParentNode): Element | null => (end === 'end' ? node.lastElementChild : node.firstElementChild);
  let copy = next(part);
  for (let level = 0; copy !== null && level < depth; level += 1) {
    if (holdsNothing(copy)) {
      copy.remove();
      return;
    }
    copy = next(copy);
  }
}

/**
 * What a container holds before and after a medium in it, taken out of it,
 * the line breaks and white space that set the medium apart gone from both
 * and no empty copy of the medium's ancestors left in either.
 * @param container - The container.
 * @param medium - The medium.
 * @returns The part before it and the part after it.
 */
function cutAround(container: Element, medium: Element): [DocumentFragment, DocumentFragment] {
  let depth = 0;
  for (let ancestor = medium.parentElement; ancestor !== null && ancestor !== container; ancestor = ancestor.parentElement) depth += 1;
  const range = container.ownerDocument.createRange();
  range.setStart(container, 0);
  range.setEndBefore(medium);
  const before = range.extractContents();
  range.setStartAfter(medium);
  range.setEnd(container, container.childNodes.length);
  const after = range.extractContents();
  trimBreaks(before, 'end');
  trimBreaks(after, 'start');
  dropEmptyCopy(before, depth, 'end');
  dropEmptyCopy(after, depth, 'start');
  return [before, after];
}

/**
 * Leaves every figure holding only what BlockNote reads out of one, a medium
 * and the first caption in it (`parseFigureElement`), and puts the rest of it
 * beside it in its order, so nothing else in a figure is lost. A figure
 * holding more than one medium, or around a figure of the medium's own, is
 * taken apart: its media are read each on its own, its caption as words. A
 * figure around a table whose cell holds the medium is left to
 * `liftCellMedia`, which puts the medium after that figure.
 * @param root - The HTML's body.
 * @returns Whether any figure changed.
 */
function readableFigures(root: Element): boolean {
  let changed = false;
  for (const figure of Array.from(root.querySelectorAll('figure'))) {
    const media = figure.querySelectorAll(HTML_MEDIA_SELECTOR);
    const medium = media[0];
    if (medium === undefined) continue;
    if (media.length > 1 || medium.closest('figure') !== figure) {
      figure.replaceWith(...Array.from(figure.childNodes));
      changed = true;
      continue;
    }
    const cell = medium.closest('td, th');
    if (cell !== null && figure.contains(cell)) continue;
    const [before, after] = cutAround(figure, medium);
    const caption = before.querySelector('figcaption') ?? after.querySelector('figcaption');
    if (caption !== null) figure.append(caption);
    figure.before(before);
    figure.after(after);
    changed = true;
  }
  return changed;
}

/**
 * Takes a medium out of the HTML with the figure around it, which holds the
 * medium and its caption alone by now (`readableFigures`).
 * @param medium - The medium.
 */
function takeOut(medium: Element): void {
  (medium.closest('figure') ?? medium).remove();
}

/**
 * Takes out every medium that does not land, before the HTML is read, so
 * the line it stands in is read whole, as without it.
 * @param root - The HTML's body.
 * @param lands - Whether a medium at an address lands.
 * @returns Whether any medium was taken out.
 */
function takeOutUnlanded(root: Element, lands: (url: string) => boolean): boolean {
  const out = Array.from(root.querySelectorAll(HTML_MEDIA_SELECTOR)).filter((medium) => !lands(medium.getAttribute('src') ?? ''));
  out.forEach(takeOut);
  return out.length > 0;
}

/**
 * Splits every line of text a medium stands in at the medium, so the medium
 * is read between the two halves of the line; a half with no words goes.
 * @param root - The HTML's body.
 * @returns Whether any line was split.
 */
function splitTextAroundMedia(root: Element): boolean {
  let changed = false;
  for (const element of Array.from(root.querySelectorAll(HTML_MEDIA_SELECTOR))) {
    const block = element.parentElement?.closest(TEXT_BLOCKS);
    if (block === null || block === undefined) continue;
    const [before, after] = cutAround(block, element);
    const head = block.cloneNode(false) as Element;
    head.append(before);
    const tail = block.cloneNode(false) as Element;
    tail.append(after);
    block.replaceWith(...[head, element, tail].filter((part) => part === element || !holdsNothing(part)));
    changed = true;
  }
  return changed;
}

/**
 * Gives every picture with a `srcset` the address of its largest candidate
 * that can be fetched, when it has one.
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
 * Pasted HTML ready to read, with how many media it carried before those
 * that do not land were taken out.
 */
export interface PreparedHTML {
  readonly html: string;
  readonly media: number;
}

/**
 * Steps that shape pasted HTML the way BlockNote reads it into blocks: tables
 * evened, figures holding only what BlockNote reads out of one, a medium in a
 * table cell put under the table.
 */
const SHAPE_FOR_BLOCKNOTE = [evenTables, readableFigures, liftCellMedia];

/**
 * Pasted HTML ready to read: its media where a block stands, each picture
 * with the address of its largest fetchable candidate, a medium that does
 * not land taken out and every line split at a medium that does.
 * @param html - The HTML.
 * @param lands - Whether a medium at an address lands in the body.
 * @returns The same HTML when nothing needed doing, the ready HTML otherwise,
 *   and how many media it carried before those that do not land went.
 */
export function preparePastedHTML(html: string, lands: (url: string) => boolean): PreparedHTML {
  if (!/<table\b/i.test(html) && !HTML_MEDIA.test(html)) return { html, media: 0 };
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const placed = [...SHAPE_FOR_BLOCKNOTE, readPictureAddresses].map((step) => step(body));
  const media = body.querySelectorAll(HTML_MEDIA_SELECTOR).length;
  const changed = [...placed, takeOutUnlanded(body, lands), splitTextAroundMedia(body)].some(Boolean);
  return { html: changed ? body.innerHTML : html, media };
}

/** BlockNote's own HTML for a media block, as its export writes it. */
const OWN_MEDIA = MEDIA_BLOCK_TYPES.map((type) => `[data-content-type="${type}"]`).join(', ');

/**
 * Pasted HTML with its media taken out and the rest as it reads with them,
 * so the rest lands the way it would have without them. A media block of
 * BlockNote's own HTML goes with its row, the rows nested under it taking
 * its place; an outside picture, video or audio goes with the figure around
 * it, once it stands where BlockNote reads it.
 * @param html - The HTML.
 * @returns The HTML without its media; an empty paragraph when nothing else
 *   was in it, since no HTML at all would have the plain text read instead.
 */
export function withoutMedia(html: string): string {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  SHAPE_FOR_BLOCKNOTE.forEach((step) => step(body));
  for (const content of Array.from(body.querySelectorAll(OWN_MEDIA))) {
    const row = content.closest('[data-node-type="blockOuter"]') ?? content;
    const nested = row.querySelector(':scope > [data-node-type="blockContainer"] > [data-node-type="blockGroup"]');
    const group = row.parentElement;
    row.replaceWith(...Array.from(nested?.children ?? []));
    // A group may not be empty (`blockGroupChild+`): read back, an emptied one
    // would come back holding a blank line.
    if (group?.matches('[data-node-type="blockGroup"]') === true && group.childElementCount === 0) group.remove();
  }
  Array.from(body.querySelectorAll(HTML_MEDIA_SELECTOR)).forEach(takeOut);
  return body.innerHTML.trim() === '' ? '<p></p>' : body.innerHTML;
}

/**
 * The HTML a paste is read from, when BlockNote's own paste
 * (`pasteExtension.ts`) would read Markdown or HTML carrying media: Markdown
 * the clipboard names; HTML carrying media, read as HTML even when its plain
 * text looks like Markdown, which would drop every picture (design §5.1);
 * plain text that looks like Markdown (`isMarkdown`) over HTML carrying none;
 * plain text alone, read as Markdown.
 * @param data - The clipboard.
 * @returns The HTML, or null when BlockNote reads HTML carrying no media or
 *   the clipboard holds nothing to read.
 */
function readSource(data: DataTransfer): string | null {
  if (data.types.includes('text/markdown')) return markdownToHTML(data.getData('text/markdown'));
  const html = data.getData('text/html');
  if (HTML_MEDIA.test(html)) return html;
  const plain = data.getData('text/plain');
  if (data.types.includes('text/html')) return isMarkdown(plain) ? markdownToHTML(plain) : null;
  return plain === '' ? null : markdownToHTML(plain);
}

/**
 * The clipboard with its HTML replaced.
 * @param data - The clipboard.
 * @param html - The HTML.
 * @returns The clipboard.
 */
function withHTML(data: DataTransfer, html: string): Pick<DataTransfer, 'types' | 'files' | 'items' | 'getData'> {
  return {
    types: data.types,
    files: data.files,
    items: data.items,
    getData: (format: string): string => (format === 'text/html' ? html : data.getData(format)),
  };
}

/**
 * Reads a paste BlockNote would read as Markdown or as HTML carrying media:
 * the HTML made ready, read once, the media that read loses counted as left
 * out, and the blocks put in. In a table cell the words are read from the
 * HTML with its media taken out, as they read without the media, and the
 * media follow them to land under the table. Every other
 * paste is BlockNote's own, and when it reads the clipboard's HTML, that HTML
 * has its tables evened.
 * @param context - What BlockNote hands the paste hook.
 * @param context.event - The paste.
 * @param context.editor - The editor.
 * @param context.defaultPasteHandler - BlockNote's own paste.
 * @returns Whether the paste was handled.
 */
export const documentPasteHandler: PasteHandler = ({ event, editor, defaultPasteHandler }) => {
  const data = event.clipboardData;
  const view = editor.prosemirrorView;
  if (data === null || view === undefined || view === null) return defaultPasteHandler();
  const { $from, $to } = view.state.selection;
  // BlockNote pastes plain text into code, and reads its own clipboard and
  // an editor's code from their own formats.
  if ($from.parent.type.spec.code === true && $to.parent.type.spec.code === true) return defaultPasteHandler();
  if (data.types.includes('vscode-editor-data') || data.types.includes('blocknote/html')) return defaultPasteHandler();
  const pasted = editor.getExtension(PASTED_MEDIA_KEY) as PastedMedia | undefined;
  /**
   * Whether a medium at an address lands in the body.
   * @param url - The address.
   * @returns True when it lands.
   */
  const lands = (url: string): boolean => pasted?.lands(url) ?? false;
  const source = readSource(data);
  if (source === null) {
    const html = data.getData('text/html');
    const prepared = preparePastedHTML(html, lands).html;
    if (prepared !== html) Object.defineProperty(event, 'clipboardData', { value: withHTML(data, prepared) });
    return defaultPasteHandler();
  }
  const prepared = preparePastedHTML(source, lands);
  const blocks = editor.tryParseHTMLToBlocks(prepared.html);
  const media = mediaIn(blocks as unknown as ReadBlock[]);
  pasted?.leaveOut(prepared.media - media.length);
  const landing = inTableCell($from)
    ? [...editor.tryParseHTMLToBlocks(withoutMedia(source)), ...media.map(({ type, props }) => ({ type, props, children: [] }))]
    : blocks;
  editor.pasteHTML(editor.blocksToFullHTML(landing as never), true);
  return true;
};
