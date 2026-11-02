// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a paste or a drop carries, read into blocks (inner#1351 + inner#1390
 * design §5.4.1, §5.4.2). Reading looks only at the clipboard or the drag;
 * where the blocks go is `document-put.ts`.
 *
 * Outside HTML with media is read by markers: each medium BlockNote would
 * read is swapped for a text marker, BlockNote reads the rest as it reads
 * words, and the media go back where their markers landed. The structure is
 * BlockNote's own read of the words; nothing here predicts how it reads a
 * medium.
 */

import { audioParse, imageParse, isMarkdown, markdownToHTML, videoParse } from '@blocknote/core';
import { DOMParser as SchemaParser, type Node as PMNode, type Schema } from '@tiptap/pm/model';

import { routeAddress } from '@web/spaces/document/document-media-address';
import { HTML_MEDIA_ELEMENTS, HTML_MEDIA_SELECTOR, isMediaBlockType, type MediaBlockType } from '@web/spaces/document/document-media-types';
import { evenPastedTables, evenTables } from '@web/spaces/document/document-table-paste';

/** A block as BlockNote's JSON writes one. */
export interface ReadBlock {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
  readonly children?: readonly ReadBlock[];
  /** The body's own node the block was read from, when a drag within the body brings it. */
  readonly [BODY_NODE]?: PMNode;
  /** Whether the block is an open end of the body's own copy with no words. */
  readonly [OPEN_EDGE]?: true;
  /** Whether the block is the nested line of words the copy's end opens into, read out to the top level. */
  readonly [OPEN_NESTED]?: true;
}

/**
 * Marks a block read off an open end of the body's own copy that holds no
 * words: a placement that would put it as a line of its own leaves it out.
 */
export const OPEN_EDGE: unique symbol = Symbol('open edge');

/**
 * Marks the line of words a copy's end opens into when that line is nested:
 * it is read out to the top level as the copy's last line, where it joins the
 * line it lands in, which only a placement by blocks does.
 */
export const OPEN_NESTED: unique symbol = Symbol('open nested end');

/**
 * Where a block read off the body's own content keeps the node it came from.
 * A symbol key, so the copies a placement makes of a block (`{ ...block }`)
 * keep it too.
 */
export const BODY_NODE: unique symbol = Symbol('body node');

/** What reads HTML into blocks and writes blocks out as HTML: the editor. */
export interface BlockReader {
  tryParseHTMLToBlocks(html: string): unknown;
  blocksToFullHTML(blocks: never): string;
  pasteHTML(html: string, raw?: boolean): void;
}

/** What a paste or a drop carries. */
export interface Read {
  /** The blocks read, none when nothing lands. */
  readonly blocks: readonly ReadBlock[];
  /** Media left out on the way. */
  readonly lost: number;
  /** The plain text, when the clipboard holds no HTML: what a code block takes as it is. */
  readonly plain: string | null;
  /**
   * The clipboard's plain text when its HTML holds no media: what a code block
   * the paste starts in takes, as BlockNote's default paste puts it there.
   */
  readonly codeText?: string | null;
  /** How the content goes into a line when it is lines of words alone: the way BlockNote pastes this format. */
  readonly paste: (reader: BlockReader) => void;
}

/** Whether a piece of HTML carries an image, a video or an audio. */
const HTML_MEDIA = new RegExp(`<(${HTML_MEDIA_ELEMENTS.join('|')})\\b`, 'i');

/** The marker a medium stands as while BlockNote reads the words around it. */
const MARKER = /(\d+)/g;

/**
 * The marker standing for medium `index`.
 * @param index - The medium's number.
 * @returns The marker text.
 */
function marker(index: number): string {
  return `${index}`;
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
 * Gives every medium an address in `src` where it has one elsewhere: a
 * picture the largest fetchable candidate of its `srcset`, a video or an
 * audio with no `src` of its own its first source that lands — a browser
 * picks a media element's source in that order (HTML's resource selection
 * algorithm), and BlockNote reads only the element's own `src`
 * (`parseVideoElement.ts:2`, `parseAudioElement.ts:2`).
 * @param root - The HTML's body.
 * @param lands - Whether a medium at an address lands.
 */
function fillAddresses(root: Element, lands: (url: string) => boolean): void {
  for (const image of Array.from(root.querySelectorAll('img[srcset]'))) {
    const url = largestCandidate(image.getAttribute('srcset') ?? '');
    if (url !== null) image.setAttribute('src', url);
  }
  for (const element of Array.from(root.querySelectorAll('video, audio'))) {
    if ((element.getAttribute('src') ?? '') !== '') continue;
    const source = Array.from(element.querySelectorAll('source[src]')).find((s) => lands(s.getAttribute('src') ?? ''));
    if (source !== undefined) element.setAttribute('src', source.getAttribute('src')!);
  }
}

/** A medium read out of HTML: its block, waiting for its marker. */
interface MarkedMedium {
  readonly type: MediaBlockType;
  readonly props: Readonly<Record<string, unknown>>;
}

/**
 * The block a medium element reads as, through BlockNote's own parse rule.
 * The rule passes over an element inside a figure (it reads the figure
 * instead), so a detached copy is read.
 * @param element - The medium.
 * @returns Its block.
 */
function mediumBlock(element: Element): MarkedMedium {
  const copy = element.cloneNode(true) as HTMLElement;
  const name = element.tagName.toLowerCase();
  const type: MediaBlockType = name === 'img' ? 'image' : name === 'video' ? 'video' : 'audio';
  const read =
    type === 'image' ? imageParse()(copy) : type === 'video' ? videoParse({})(copy) : audioParse()(copy);
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(read ?? {})) {
    if (value !== undefined && key !== 'backgroundColor') props[key] = value;
  }
  props['url'] = element.getAttribute('src') ?? '';
  return { type, props };
}

/**
 * Swaps every medium in the HTML for its marker. A medium that does not land
 * is taken out and counted, and its figure's caption stays as words; one that
 * lands is read into its block, its figure's caption becoming its caption
 * when it is the figure's only medium that lands.
 * @param root - The HTML's body.
 * @param lands - Whether a medium at an address lands.
 * @returns The media, by marker number, and how many were taken out.
 */
function markMedia(root: Element, lands: (url: string) => boolean): { media: MarkedMedium[]; lost: number } {
  // A fallback inside a video or an audio is not a medium of its own.
  const elements = Array.from(root.querySelectorAll(HTML_MEDIA_SELECTOR)).filter(
    (element) => !element.parentElement?.closest(HTML_MEDIA_SELECTOR),
  );
  let lost = 0;
  const landing: Element[] = [];
  for (const element of elements) {
    if (lands(element.getAttribute('src') ?? '')) {
      landing.push(element);
    } else {
      (element.closest('picture') ?? element).remove();
      lost += 1;
    }
  }
  const perFigure = new Map<Element, number>();
  for (const element of landing) {
    const figure = element.closest('figure');
    if (figure !== null) perFigure.set(figure, (perFigure.get(figure) ?? 0) + 1);
  }
  const media: MarkedMedium[] = [];
  for (const element of landing) {
    const block = mediumBlock(element);
    const figure = element.closest('figure');
    const caption = figure !== null && perFigure.get(figure) === 1 ? figure.querySelector('figcaption') : null;
    const props = caption === null ? block.props : { ...block.props, caption: (caption.textContent ?? '').trim() };
    caption?.remove();
    (element.closest('picture') ?? element).replaceWith(root.ownerDocument.createTextNode(marker(media.length)));
    media.push({ type: block.type, props });
  }
  return { media, lost };
}

/** Inline content as BlockNote's JSON writes it. */
export type Inline = { type: string; text?: string; content?: Inline[]; [key: string]: unknown };

/** A run of inline content, or a medium's number. */
type Piece = { readonly words: Inline[] } | { readonly medium: number };

/**
 * Splits inline content at its markers.
 * @param content - The inline content.
 * @returns The runs of words and the media between them, in order; the
 *   first and the last are runs, possibly empty.
 */
function splitAtMarkers(content: readonly Inline[]): Piece[] {
  const pieces: Piece[] = [{ words: [] }];
  /**
   * The run being filled.
   * @returns It.
   */
  const current = (): Inline[] => (pieces[pieces.length - 1] as { words: Inline[] }).words;
  for (const item of content) {
    if (item.type === 'link' && Array.isArray(item.content)) {
      const inner = splitAtMarkers(item.content);
      inner.forEach((piece, index) => {
        if ('medium' in piece) {
          pieces.push(piece, { words: [] });
        } else if (piece.words.length > 0) {
          current().push({ ...item, content: piece.words });
        } else if (index === 0 && inner.length === 1) {
          current().push(item);
        }
      });
      continue;
    }
    if (typeof item.text !== 'string') {
      current().push(item);
      continue;
    }
    let last = 0;
    for (const match of item.text.matchAll(MARKER)) {
      const before = item.text.slice(last, match.index);
      if (before !== '') current().push({ ...item, text: before });
      pieces.push({ medium: Number(match[1]) }, { words: [] });
      last = match.index! + match[0].length;
    }
    const after = item.text.slice(last);
    if (after !== '' || last === 0) current().push({ ...item, text: after });
  }
  return pieces;
}

/**
 * The plain text of inline content.
 * @param content - The content.
 * @returns Its words.
 */
export function textOf(content: readonly Inline[]): string {
  return content.map((item) => (typeof item.text === 'string' ? item.text : textOf(item.content ?? []))).join('');
}

/**
 * The words of a block's content when it is words: inline content, or the
 * string BlockNote takes as one run of text.
 * @param content - The content.
 * @returns The words, or null for content that is not words (a table, none).
 */
export function wordsIn(content: unknown): string | null {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? textOf(content as Inline[]) : null;
}

/**
 * A table cell's inline content: BlockNote writes a cell as the content
 * itself or as a cell object holding it.
 * @param cell - The cell.
 * @returns Its inline content.
 */
export function cellInline(cell: unknown): Inline[] {
  return Array.isArray(cell) ? (cell as Inline[]) : ((cell as { content?: Inline[] }).content ?? []);
}

/**
 * Inline content with white space taken off one end.
 * @param content - The content.
 * @param end - Which end.
 * @param pattern - What to take off that end.
 * @returns The content.
 */
function trimEnd(content: readonly Inline[], end: 'start' | 'end', pattern: RegExp): Inline[] {
  const items = [...content];
  while (items.length > 0) {
    const index = end === 'start' ? 0 : items.length - 1;
    const item = items[index]!;
    if (typeof item.text !== 'string') {
      if (item.type !== 'link' || !Array.isArray(item.content)) break;
      const inner = trimEnd(item.content, end, pattern);
      if (inner.length === 0) {
        items.splice(index, 1);
        continue;
      }
      items[index] = { ...item, content: inner };
      break;
    }
    const text = item.text.replace(pattern, '');
    if (text === '') {
      items.splice(index, 1);
      continue;
    }
    items[index] = { ...item, text };
    break;
  }
  return items;
}

/** List item block types, whose media go under the item. */
const LIST_ITEMS = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);

/**
 * The media blocks markers stand for, each found once.
 * @param indices - The numbers.
 * @param media - The media read.
 * @param found - Collects the numbers found.
 * @returns The blocks.
 */
function mediaBlocks(indices: readonly number[], media: readonly MarkedMedium[], found: Set<number>): ReadBlock[] {
  return indices.flatMap((index) => {
    const medium = media[index];
    if (medium === undefined || found.has(index)) return [];
    found.add(index);
    return [{ type: medium.type, props: medium.props }];
  });
}

/**
 * The halves of a run of words a marker cut, its cut edges cleaned: in a code
 * block one line break next to the marker goes, with the line the medium had
 * to itself; elsewhere the white space and line breaks at the cut.
 * @param words - The run.
 * @param code - Whether it is code.
 * @param after - Whether a marker is after this run.
 * @param before - Whether a marker is before this run.
 * @returns The run, cleaned.
 */
function cleanCut(words: readonly Inline[], code: boolean, after: boolean, before: boolean): Inline[] {
  let out = [...words];
  if (!code) {
    if (after) out = trimEnd(out, 'end', /\s+$/);
    if (before) out = trimEnd(out, 'start', /^\s+/);
    return out;
  }
  if (after) {
    const text = textOf(out);
    const lineBefore = text.slice(text.lastIndexOf('\n') + 1);
    out = trimEnd(out, 'end', lineBefore.trim() === '' ? /\n?[ \t]*$/ : /^$/);
  }
  if (before) {
    const text = textOf(out);
    const end = text.indexOf('\n');
    const lineAfter = end < 0 ? text : text.slice(0, end);
    out = trimEnd(out, 'start', lineAfter.trim() === '' ? /^[ \t]*\n?/ : /^$/);
  }
  return out;
}

/**
 * Blocks with their markers put back as media: a list item keeps the words
 * before its first marker and takes the media and the rest as its first
 * children; a table's media go under it; any other block of words splits
 * at each marker, its halves keeping its type.
 * @param blocks - The blocks read.
 * @param media - The media, by marker number.
 * @param found - Collects the marker numbers found.
 * @returns The blocks.
 */
function placeMarkers(blocks: readonly ReadBlock[], media: readonly MarkedMedium[], found: Set<number>): ReadBlock[] {
  return blocks.flatMap((block): ReadBlock[] => {
    const children = placeMarkers(block.children ?? [], media, found);
    if (block.type === 'table') {
      const indices: number[] = [];
      const content = cleanTable(block.content, indices);
      return [{ ...block, content, children }, ...mediaBlocks(indices, media, found)];
    }
    if (!Array.isArray(block.content)) return [{ ...block, children }];
    const pieces = splitAtMarkers(block.content as Inline[]);
    if (pieces.length === 1) return [{ ...block, children }];
    const code = block.type === 'codeBlock';
    const runs = pieces.map((piece, index) =>
      'medium' in piece ? piece : { words: cleanCut(piece.words, code, index < pieces.length - 1, index > 0) },
    );
    /**
     * Whether a piece is words that are not all white space.
     * @param piece - The piece.
     * @returns True when it has words.
     */
    const hasWords = (piece: Piece): boolean => 'words' in piece && textOf(piece.words).trim() !== '';
    if (LIST_ITEMS.has(block.type)) {
      const [front, ...rest] = runs;
      const nested = rest.flatMap((piece): ReadBlock[] =>
        'medium' in piece ? mediaBlocks([piece.medium], media, found) : hasWords(piece) ? [{ type: 'paragraph', content: piece.words }] : [],
      );
      return [{ ...block, content: (front as { words: Inline[] }).words, children: [...nested, ...children] }];
    }
    const out: ReadBlock[] = [];
    for (const piece of runs) {
      if ('medium' in piece) out.push(...mediaBlocks([piece.medium], media, found));
      else if (hasWords(piece)) out.push({ ...block, content: piece.words, children: [] });
    }
    if (children.length > 0) {
      const kept = out.findLastIndex((b) => !isMediaBlockType(b.type));
      if (kept >= 0) out[kept] = { ...out[kept]!, children };
      else out.push(...children);
    }
    return out;
  });
}

/**
 * A cell's words with its markers taken out, read as they would be without
 * those media: white space at a cut is dropped at the cell's edges and, in
 * the middle, kept as one space when either side had any, as HTML collapses
 * the white space around an element that is not there.
 * @param inline - The cell's words.
 * @param indices - Collects the marker numbers, in order.
 * @returns The words.
 */
function cellWithoutMarkers(inline: readonly Inline[], indices: number[]): Inline[] {
  const pieces = splitAtMarkers(inline);
  const runs: Inline[][] = [];
  const spaced: boolean[] = [];
  pieces.forEach((piece, index) => {
    if ('medium' in piece) {
      indices.push(piece.medium);
      return;
    }
    const text = textOf(piece.words);
    const cutAfter = index < pieces.length - 1;
    const cutBefore = index > 0;
    if (cutBefore) spaced[runs.length] = (spaced[runs.length] ?? false) || /^\s/.test(text);
    if (cutAfter) spaced[runs.length + 1] = /\s$/.test(text);
    runs.push(cleanCut(piece.words, false, cutAfter, cutBefore));
  });
  const out: Inline[] = [];
  let space = false;
  runs.forEach((run, index) => {
    space ||= spaced[index] === true;
    if (textOf(run) === '' && run.every((item) => typeof item.text === 'string')) return;
    if (out.length > 0 && space) out.push({ type: 'text', text: ' ', styles: {} });
    space = false;
    out.push(...run);
  });
  return out;
}

/**
 * A table's content with the markers taken out of its cells.
 * @param content - The table content.
 * @param indices - Collects the marker numbers, in order.
 * @returns The content.
 */
function cleanTable(content: unknown, indices: number[]): unknown {
  const table = content as { rows?: { cells: unknown[] }[] } | undefined;
  if (table?.rows === undefined) return content;
  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => {
        const words = cellWithoutMarkers(cellInline(cell), indices);
        return Array.isArray(cell) ? words : { ...(cell as object), content: words };
      }),
    })),
  };
}

/**
 * Blocks without the line break that closes a line's words: a `<br>` ending
 * a block draws no line of its own, so `<p><br></p>` is an empty line, as
 * ProseMirror parses it. Code keeps every line break.
 * @param blocks - The blocks.
 * @returns The blocks.
 */
function withoutClosingBreak(blocks: readonly ReadBlock[]): ReadBlock[] {
  return blocks.map((block) => {
    const children = withoutClosingBreak(block.children ?? []);
    if (block.type === 'codeBlock' || !Array.isArray(block.content)) return { ...block, children };
    const content = [...(block.content as Inline[])];
    const last = content[content.length - 1];
    if (typeof last?.text === 'string' && last.text.endsWith('\n')) {
      if (last.text === '\n') content.pop();
      else content[content.length - 1] = { ...last, text: last.text.slice(0, -1) };
    }
    return { ...block, content, children };
  });
}

/**
 * Outside HTML read into blocks by markers (§5.4.2).
 * @param reader - The editor.
 * @param html - The HTML.
 * @param lands - Whether a medium at an address lands.
 * @returns The blocks and how many media were left out.
 */
function readByMarkers(reader: BlockReader, html: string, lands: (url: string) => boolean): { blocks: ReadBlock[]; lost: number } {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  evenTables(body);
  fillAddresses(body, lands);
  const { media, lost } = markMedia(body, lands);
  const found = new Set<number>();
  const blocks = placeMarkers(withoutClosingBreak(reader.tryParseHTMLToBlocks(body.innerHTML) as ReadBlock[]), media, found);
  return { blocks, lost: lost + media.length - found.size };
}

/**
 * The language VS Code says copied code is in, or null when the data names
 * none (a copy too large to highlight writes `"mode": null`) or is broken,
 * where BlockNote's own `handleVSCodePaste` would throw.
 * @param data - The `vscode-editor-data` format's text.
 * @returns The language, or null.
 */
function editorLanguage(data: string): string | null {
  try {
    const mode = (JSON.parse(data) as { mode?: unknown } | null)?.mode;
    return typeof mode === 'string' && mode !== '' ? mode : null;
  } catch {
    return null;
  }
}

/**
 * HTML escaped as text.
 * @param text - The text.
 * @returns The HTML.
 */
function escapeHTML(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A clipboard or a drag, as a paste or a drop hands it. */
export type Transfer = Pick<DataTransfer, 'types' | 'getData'>;

/**
 * Reads what a paste or a drop carries (§5.4.1): the body's own copy as it
 * is, an editor's code as one code block, Markdown, HTML with media and
 * plain text by markers, and any other HTML with its tables evened. Where
 * it goes is `putContent`'s to settle.
 * @param reader - The editor.
 * @param data - The clipboard or the drag.
 * @param lands - Whether a medium at an address lands.
 * @returns The blocks read, the media left out reading them, the plain text a code block takes as it is, and the paste that puts words alone in.
 */
export function readTransfer(reader: BlockReader, data: Transfer, lands: (url: string) => boolean): Read {
  const plain = data.getData('text/plain');
  const html = data.types.includes('text/html') ? data.getData('text/html') : '';
  if (data.types.includes('blocknote/html')) {
    const own = data.getData('blocknote/html');
    return { blocks: withOpenEdges(reader.tryParseHTMLToBlocks(own) as ReadBlock[], own), lost: 0, plain: null, paste: (r) => r.pasteHTML(own, true) };
  }
  const plainOnly = html === '' && plain !== '' ? plain : null;
  const mode = data.types.includes('vscode-editor-data') ? editorLanguage(data.getData('vscode-editor-data')) : null;
  if (mode !== null && plain !== '') {
    const code = `<pre><code class="language-${escapeHTML(mode)}">${escapeHTML(plain.replace(/\r\n?/g, '\n'))}</code></pre>`;
    return { blocks: reader.tryParseHTMLToBlocks(code) as ReadBlock[], lost: 0, plain: plainOnly, paste: (r) => r.pasteHTML(code) };
  }
  const markdown = data.types.includes('text/markdown');
  const withMedia = HTML_MEDIA.test(html);
  const codeText = !withMedia && plain !== '' ? plain : null;
  if (!markdown && !withMedia && html !== '' && !isMarkdown(plain)) {
    const even = evenPastedTables(html);
    return { blocks: reader.tryParseHTMLToBlocks(even) as ReadBlock[], lost: 0, plain: null, codeText, paste: (r) => r.pasteHTML(even) };
  }
  if (!markdown && plain === '' && html === '') return { blocks: [], lost: 0, plain: null, paste: () => undefined };
  const source = markdown ? markdownToHTML(data.getData('text/markdown')) : withMedia ? html : markdownToHTML(plain);
  const { blocks, lost } = readByMarkers(reader, source, lands);
  return { blocks, lost, plain: plainOnly, codeText, paste: (r) => r.pasteHTML(r.blocksToFullHTML(blocks as never), true) };
}

/**
 * Reads the body's own content, as a drag within the body carries it: the
 * blocks a paste of the same clipboard HTML reads, each keeping the body's
 * own node it came from (its comments and its row id), read from the same
 * HTML the same way BlockNote reads it, a block group of containers.
 * @param reader - The editor.
 * @param html - The content's clipboard HTML.
 * @param schema - The body's schema.
 * @returns The content read.
 */
export function readBodyContent(reader: BlockReader, html: string, schema: Schema): Read {
  const blocks = reader.tryParseHTMLToBlocks(html) as ReadBlock[];
  const dom = document.createElement('div');
  dom.innerHTML = html;
  const group = SchemaParser.fromSchema(schema).parse(dom, { topNode: schema.nodes['blockGroup']!.create() });
  /**
   * Keeps on each block the node it was read from, its nested ones too.
   * @param list - The blocks.
   * @param nodes - The nodes they were read from, in order.
   * @returns The blocks.
   */
  const sourced = (list: readonly ReadBlock[], nodes: readonly PMNode[]): ReadBlock[] =>
    list.length !== nodes.length
      ? [...list]
      : list.map((block, i) => {
        const node = nodes[i]!;
        const nested = node.lastChild?.type.name === 'blockGroup' ? node.lastChild.children : [];
        return { ...block, children: sourced(block.children ?? [], nested), [BODY_NODE]: node };
      });
  return { blocks: withOpenEdges(sourced(blocks, group.children), html), lost: 0, plain: null, paste: (r) => r.pasteHTML(html, true) };
}

/**
 * The body's own copy with its open ends read the same at any depth.
 * ProseMirror records how deep each end of a copied slice is open
 * (`data-pm-slice`, plus two levels per node of the context it wraps the
 * slice in). Each end opens into one line, which this reads as a top-level
 * block: the nested line the end opens into is read out of its parent, and
 * the parents the start opens through, whose words lie before the copy, are
 * left out. An open end with no words is the boundary of a line the copy only
 * touched, which joins the line it lands in and is no line of its own
 * (`OPEN_EDGE`); it has no type of its own and reads as an empty paragraph.
 * @param blocks - The blocks read.
 * @param html - The copy's clipboard HTML.
 * @returns The blocks.
 */
function withOpenEdges(blocks: readonly ReadBlock[], html: string): ReadBlock[] {
  const marker = /data-pm-slice="(\d+) (\d+) ([^"]*)"/.exec(html);
  if (marker === null) return [...blocks];
  /**
   * How many lines an end opens through: each block group and block container
   * it opens is one level, the slice's context included.
   * @param open - The end's open depth, as `data-pm-slice` records it.
   * @returns The lines.
   */
  const levels = (open: string): number => Math.floor((Number(open) + 2 * contextDepth(marker[3]!) - 1) / 2);
  /**
   * Whether a block is a line with no words and nothing nested.
   * @param block - The block.
   * @returns True for such a line.
   */
  const blank = (block: ReadBlock | undefined): boolean => block !== undefined && wordsIn(block.content) === '' && (block.children ?? []).length === 0;
  const out = [...blocks];
  const start = levels(marker[1]!);
  let wrappers = 0;
  while (wrappers < start - 1 && blank(out[wrappers])) wrappers += 1;
  if (wrappers > 0 && wrappers < out.length && !blank(out[wrappers])) out.splice(0, wrappers);
  const end = levels(marker[2]!);
  /**
   * A block without the nested line its end opens into, and that line.
   * @param block - The block.
   * @param depth - How many levels of nested lines the end still opens through.
   * @returns The block and the line, or no line when the end opens no deeper.
   */
  const openLine = (block: ReadBlock, depth: number): [ReadBlock, ReadBlock | null] => {
    const children = block.children ?? [];
    const last = children[children.length - 1];
    if (depth === 0 || last === undefined) return [block, null];
    const [kept, line] = openLine(last, depth - 1);
    if (line === null) return [{ ...block, children: children.slice(0, -1) }, last];
    return [{ ...block, children: [...children.slice(0, -1), kept] }, line];
  };
  if (end > 1 && out.length > 0) {
    const [kept, line] = openLine(out[out.length - 1]!, end - 1);
    if (line !== null) out.splice(out.length - 1, 1, kept, blank(line) ? line : { ...line, [OPEN_NESTED]: true });
  }
  /**
   * An open end with no words, as the empty paragraph it reads as.
   * @param block - The block.
   * @returns The marked block.
   */
  const edge = (block: ReadBlock): ReadBlock => ({ type: 'paragraph', content: [], children: [], [OPEN_EDGE]: true, ...(block[BODY_NODE] === undefined ? {} : { [BODY_NODE]: block[BODY_NODE] }) });
  for (let i = 0; i < start && i < out.length - 1 && blank(out[i]); i += 1) out[i] = edge(out[i]!);
  for (let i = out.length - 1; out.length - 1 - i < end && i > 0 && blank(out[i]); i -= 1) out[i] = edge(out[i]!);
  return out;
}

/**
 * How many nodes the context of a copied slice wraps it in.
 * @param context - The context ProseMirror writes into `data-pm-slice`, HTML-escaped or not.
 * @returns The count; none when it cannot be read.
 */
function contextDepth(context: string): number {
  try {
    const nodes: unknown = JSON.parse(context.replaceAll('&quot;', '"'));
    return Array.isArray(nodes) ? Math.floor(nodes.length / 2) : 0;
  } catch {
    return 0;
  }
}
