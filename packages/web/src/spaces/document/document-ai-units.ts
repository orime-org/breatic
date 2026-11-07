// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the AI output dialog sends, previews and writes (inner#1860, design
 * §4.6, §5.1–§5.3): the original range goes out as one piece of Markdown,
 * the whole answer read into blocks is the preview, and replace pastes it
 * over the range the way Plate's `replaceSelection` does. Words inside a
 * code block go out as their code and come back as code.
 *
 * The escaping going out and the decoding coming back are a pair, fitted to
 * BlockNote 0.56's own Markdown exporter and parser (§5.1): the exporter
 * writes words as they are, and the parser decodes no entity, collapses runs
 * of spaces, and puts a space after every hard break.
 */

import { blockToNode, inlineContentToNodes, nodeToBlock } from '@blocknote/core';
import { Fragment, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { yUndoPluginKey } from 'y-prosemirror';

import { aiCoverIn, BN_BLOCK } from '@web/spaces/document/document-ai-range';
import type { DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import type { ViewedEditor } from '@web/spaces/document/document-editor-view';
import type { WrittenBlock } from '@web/spaces/document/document-external-media';
import type { LocalRange } from '@web/spaces/document/document-local-range';
import { blocksInContext } from '@web/spaces/document/document-proposal-blocks';
import {
  asOneUndoStep,
  blockById,
  keepWritable,
  writeRefusal,
  type ProposalAdmission,
  type UndoBoundary,
} from '@web/spaces/document/document-proposal-landing';
import { LEGACY_CELL_LINE } from '@web/spaces/document/document-table-legacy';
import { blocksMarkdown, type BlockLike } from '@web/spaces/document/document-table-markdown';
import { blockInTableCell, cellDepthOf, DOC_TABLE } from '@web/spaces/document/document-table-nodes';

/** How a write ended. */
export type AiWriteResult =
  | { readonly outcome: 'written'; readonly leftOut?: number }
  | { readonly outcome: 'mediaOnly'; readonly leftOut: number }
  | { readonly outcome: 'readOnly' | 'failed' | 'targetGone' };

/** An answer read into blocks. */
export interface AiAnswer {
  /** What the preview shows and insert and replace write, in order. */
  readonly preview: readonly WrittenBlock[];
  /** How many outside media were left out. */
  readonly leftOut: number;
}

/** A code block's type. */
const CODE = 'codeBlock';

/** The list item types, whose answers take no block props (Plate `formatAIOutput`). */
const LIST_ITEMS = new Set(['bulletListItem', 'numberedListItem', 'checkListItem', 'toggleListItem']);

/** The punctuation BlockNote 0.56's parser takes a backslash before. */
const BACKSLASHED = /[\\`*_{}[\]()#+\-.!~|>]/g;

/** One inline piece of a block, loosely typed. */
interface Inline {
  type: string;
  text?: string;
  href?: string;
  styles?: Record<string, unknown>;
  content?: Inline[];
}

/** A block as BlockNote reads it, loosely typed. */
interface Read extends WrittenBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: Read[];
}

/**
 * A character spelled as a numeric reference, which the way back decodes.
 * @param ch - The character.
 * @returns The reference.
 */
function entity(ch: string): string {
  return `&#${String(ch.codePointAt(0))};`;
}

/**
 * White space a Markdown round trip would lose, spelled as entities: any at
 * either end of a line, and any after another; tabs too.
 * @param text - Words already escaped.
 * @param before - The character before them; a newline at a line's start.
 * @param after - The character after them; a newline at a line's end.
 * @returns The words with those spaces kept.
 */
function keepSpaces(text: string, before: string, after: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const prev = i === 0 ? before : text[i - 1]!;
    const next = i === text.length - 1 ? after : text[i + 1]!;
    const kept = ch === '\t' || (isSpace(ch) && (prev === '\n' || isSpace(prev) || next === '\n'));
    out += kept ? entity(ch) : ch;
  }
  return out;
}

/**
 * Whether a character is white space other than a line break: the exporter
 * trims any of them at a line's edges, an ideographic space included.
 * @param ch - The character.
 * @returns True for one.
 */
function isSpace(ch: string): boolean {
  return ch !== '\n' && /\s/.test(ch);
}

/**
 * Escapes words for the request (§5.1): a backslash before the parser's
 * punctuation outside code, `&` and `<` as entities everywhere.
 * @param text - The words.
 * @param code - Whether they are inline code, where a backslash is kept as written.
 * @returns The escaped words.
 */
function escapeWords(text: string, code: boolean): string {
  const entities = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // A web address the parser would turn into a link stays words: its `:` is
  // spelled as an entity.
  // A backslash the words hold is spelled as an entity, so every backslash
  // left after parsing is one the model wrote to escape punctuation.
  // A `|` is spelled as an entity too: a pipe table escapes its own, and a
  // second backslash before it would end the cell there.
  return code ? entities : entities.replace(BACKSLASHED, (c) => (c === '\\' ? '&#92;' : c === '|' ? '&#124;' : `\\${c}`)).replace(/:\/\//g, '&#58;//');
}

/** The styles Markdown writes around words, which cannot open or close at a space. */
const EMPHASIS = ['bold', 'italic', 'strike'] as const;

/** What stands between two neighbouring emphasis runs, so the parser can tell them apart; taken out on the way back. */
const RUN_BREAK = '&aibreak;';

/** The piece that carries it; known by identity, so words that read the same are escaped as words. */
const RUN_BREAK_PIECE: Inline = { type: 'text', text: RUN_BREAK, styles: {} };

/**
 * Whether a piece is emphasised, and how.
 * @param piece - The piece.
 * @returns Its emphasis styles, in a fixed order.
 */
function emphasisOf(piece: Inline): string {
  return piece.type === 'text' ? EMPHASIS.filter((style) => piece.styles?.[style] === true).join(',') : '';
}

/**
 * The emphasis at one end of a piece: its own, or for a link that of its
 * first or last run.
 * @param piece - The piece.
 * @param end - Which end.
 * @returns The emphasis styles there.
 */
function edgeEmphasis(piece: Inline, end: 'start' | 'end'): string {
  if (piece.type !== 'link') return emphasisOf(piece);
  const runs = piece.content ?? [];
  const edge = end === 'start' ? runs[0] : runs[runs.length - 1];
  return edge === undefined ? '' : emphasisOf(edge);
}

/**
 * Inline content with emphasised neighbours kept apart, inside links too.
 * BlockNote's exporter closes and reopens emphasis at a link's edge and
 * between runs, and its parser reads two delimiters that touch as one.
 * @param content - The content.
 * @returns It, with breaks between such neighbours.
 */
function exportable(content: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const raw of content) {
    const piece = raw.type === 'link' ? { ...raw, content: exportable(raw.content ?? []) } : raw;
    const last = out[out.length - 1];
    if (last !== undefined) {
      const left = edgeEmphasis(last, 'end');
      const right = edgeEmphasis(piece, 'start');
      // Two links side by side are closed and reopened one after the other, emphasis and all.
      if (left !== '' && right !== '' && (left !== right || last.type !== piece.type || piece.type === 'link')) out.push(RUN_BREAK_PIECE);
    }
    out.push(piece);
  }
  return out;
}

/**
 * The words of a piece of inline content.
 * @param piece - The piece.
 * @returns Its words.
 */
function wordsOf(piece: Inline): string {
  return piece.type === 'link' ? (piece.content ?? []).map((t) => t.text ?? '').join('') : piece.text ?? '';
}

/**
 * Escapes a block's inline content for the request, its spaces kept.
 * @param content - The content.
 * @returns It, escaped.
 */
function escapeContent(content: readonly Inline[]): Inline[] {
  const all = content.map(wordsOf).join('');
  const shaped = exportable(content);
  let at = 0;
  /**
   * Escapes one text piece, knowing what lies around it.
   * @param piece - The piece.
   * @returns It, escaped.
   */
  const one = (piece: Inline): Inline => {
    if (piece === RUN_BREAK_PIECE) return piece;
    const text = piece.text ?? '';
    const before = at === 0 ? '\n' : all[at - 1]!;
    const after = at + text.length >= all.length ? '\n' : all[at + text.length]!;
    at += text.length;
    const code = piece.styles?.['code'] === true;
    let escaped = keepSpaces(escapeWords(text, code), before, after);
    // A backtick in code would need a longer fence than the exporter picks.
    if (code) escaped = escaped.replace(/`/g, '&#96;');
    // A code span loses one space at each end when it has both, and emphasis
    // cannot open or close at a space: those spaces are spelled as entities.
    if (code && /^ [\s\S]* $/.test(escaped)) escaped = `&#32;${escaped.slice(1, -1)}&#32;`;
    if (emphasisOf(piece) !== '') escaped = escaped.replace(/^[^\S\n]+|[^\S\n]+$/g, (edge) => [...edge].map(entity).join(''));
    // A hard break is spelled as an entity: the exporter drops one at a block's
    // edge, the parser ends a heading or a list item at one, and a line
    // starting with `=` or other block syntax would be read as a block.
    return { ...piece, text: escaped.replace(/\n/g, '&#10;') };
  };
  return shaped.map((c) => {
    if (c.type === 'link') {
      // The parser ends an address at white space, reads emphasis and strike
      // delimiters in it, and decodes nothing; the way back decodes every
      // entity and unescapes it once: all of them are spelled as entities.
      const href = (c.href ?? '').replace(/&/g, '&amp;').replace(/[\\\s*~]/g, entity);
      const content = (c.content ?? []).map(one);
      // Words that read as their address are exported as the bare address,
      // which reads back as words: their first character is spelled another
      // way, which reads back the same.
      const [first, ...rest] = content;
      if (first?.text !== undefined && content.map((t) => t.text ?? '').join('') === href) return { ...c, href, content: [{ ...first, text: respelled(first.text) }, ...rest] };
      return { ...c, href, content };
    }
    return c.type === 'text' ? one(c) : c;
  });
}

/**
 * Escaped words with their first character spelled another way: a reference
 * in hexadecimal, a character as a reference.
 * @param text - The escaped words, not empty.
 * @returns They, reading back the same.
 */
function respelled(text: string): string {
  const reference = /^&#?\w+;/.exec(text)?.[0];
  if (reference !== undefined) return `&#x${decoded(reference).codePointAt(0)!.toString(16)};${text.slice(reference.length)}`;
  const ch = String.fromCodePoint(text.codePointAt(0)!);
  return entity(ch) + text.slice(ch.length);
}

/**
 * Decodes the entities the request spelled, and the ones a model writes.
 * @param text - Words as parsed.
 * @returns The words.
 */
function decoded(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole: string, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    // Every `<` was spelled as an entity before parsing, so the words hold no
    // markup and the browser's own decoder can read the named reference.
    const decoder = document.createElement('textarea');
    decoder.innerHTML = whole;
    return decoder.value;
  });
}

/** A backslash before ASCII punctuation, as Markdown writes it. */
const BACKSLASH_ESCAPE = /\\([!-/:-@[-`{-~])/g;

/** A backslash before the ASCII punctuation BlockNote 0.56's parser leaves escaped. */
const LEFT_ESCAPE = /\\(["$%&',/:;<=?@^])/g;

/**
 * What an escaped backslash in an answer (`\\`) is held as while it is
 * parsed: after parsing, a backslash left before punctuation is then always
 * one the model wrote to escape it. It is two backslashes again in code.
 */
const BACKSLASH_PAIR = '&aibs;';

/**
 * Inline content as written back: the space the parser puts after a hard
 * break taken out, entities decoded, a link's address unescaped.
 * @param content - The parsed content.
 * @param code - Whether it is a code block's, whose spaces and line breaks are code.
 * @returns The content.
 */
function fixedInline(content: readonly Inline[], code = false): Inline[] {
  if (code) return content.map((c) => (c.type === 'text' ? { ...c, text: decoded(asCode(c.text ?? '')) } : c));
  // A link the parser made from an address keeps every backslash in its
  // address and words; those are taken out here, once.
  const unescaped = new Set<Inline>();
  const out = content.map((c): Inline => {
    if (c.type !== 'link') return { ...c };
    const href = decoded(asWords((c.href ?? '').replace(BACKSLASH_ESCAPE, '$1')));
    const bare = (c.content ?? []).map((t) => ({ ...t, text: asWords((t.text ?? '').replace(BACKSLASH_ESCAPE, '$1')) }));
    if (bare.map((t) => t.text).join('') !== href) return { ...c, href, content: (c.content ?? []).map((t) => ({ ...t })) };
    bare.forEach((t) => unescaped.add(t));
    return { ...c, href, content: bare };
  });
  // A hard break can end a link's words, so the space after it is looked for
  // across pieces, in reading order.
  let afterBreak = false;
  for (const piece of out.flatMap((c) => (c.type === 'link' ? c.content ?? [] : [c]))) {
    if (piece.type !== 'text') {
      afterBreak = false;
      continue;
    }
    // Outside code, a backslash before ASCII punctuation is an escape
    // (CommonMark 0.31 §2.4); the parser takes out the ones in its own set.
    let text = (piece.text ?? '').replace(/\n /g, '\n').split(RUN_BREAK).join('');
    if (piece.styles?.['code'] === true) text = asCode(text);
    else if (!unescaped.has(piece)) text = asWords(text.replace(LEFT_ESCAPE, '$1'));
    if (afterBreak && text.startsWith(' ')) text = text.slice(1);
    afterBreak = text.endsWith('\n');
    piece.text = decoded(text);
  }
  return out;
}

/**
 * Code with its held backslash pairs as they were written.
 * @param text - Code as parsed.
 * @returns It.
 */
function asCode(text: string): string {
  return text.split(BACKSLASH_PAIR).join('\\\\');
}

/**
 * Words with each held backslash pair read as the one backslash it escapes.
 * @param text - Words as parsed, the model's own escapes taken out.
 * @returns They.
 */
function asWords(text: string): string {
  return text.split(BACKSLASH_PAIR).join('\\');
}

/**
 * A parsed block with its words fixed, children included.
 * @param block - The block.
 * @returns It.
 */
function fixedBlock(block: Read): Read {
  const content = Array.isArray(block.content) ? fixedInline(block.content as Inline[], block.type === CODE) : block.content;
  return { ...block, content, children: (block.children ?? []).map(fixedBlock) };
}

/**
 * Inline content with neighbouring text of the same styles joined, as the
 * body keeps it.
 * @param content - The content.
 * @returns It, joined.
 */
function joined(content: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const c of content) {
    if (c.type === 'text' && (c.text ?? '') === '') continue;
    const last = out[out.length - 1];
    if (last?.type === 'text' && c.type === 'text' && JSON.stringify(last.styles ?? {}) === JSON.stringify(c.styles ?? {})) {
      out[out.length - 1] = { ...last, text: (last.text ?? '') + (c.text ?? '') };
    } else {
      out.push(c);
    }
  }
  return out;
}

/**
 * The inline content of some blocks in order, a line break between blocks;
 * images, tables and the like left out.
 * @param blocks - The blocks.
 * @returns The content.
 */
function flattened(blocks: readonly Read[]): Inline[] {
  const out: Inline[] = [];
  /**
   * Takes in a list of blocks, children after their parent.
   * @param list - The blocks.
   */
  const walk = (list: readonly Read[]): void => {
    for (const block of list) {
      if (block.type === DOC_TABLE || block.type === 'table') continue;
      if (Array.isArray(block.content)) {
        if (out.length > 0) out.push({ type: 'text', text: '\n', styles: {} });
        out.push(...(block.content as Inline[]));
      }
      walk(block.children ?? []);
    }
  };
  walk(blocks);
  return joined(out);
}


/**
 * The body's undo manager, as the undo plugin holds it.
 * @param handle - The document.
 * @returns It, or null for a body built without one.
 */
function undoOf(handle: Pick<DocumentEditorHandle, 'editor'>): UndoBoundary | null {
  const state = yUndoPluginKey.getState(handle.editor.prosemirrorState) as { undoManager?: UndoBoundary } | undefined;
  return state?.undoManager ?? null;
}

/**
 * A code block's words for the request: `&` and `<` as entities, and a line
 * break at either end as one, which the exporter would drop.
 * @param text - The code.
 * @returns It, escaped.
 */
function escapeCode(text: string): string {
  return escapeWords(text, true).replace(/^\n/, '&#10;').replace(/\n$/, '&#10;');
}

/**
 * Blocks with their words escaped for Markdown (§5.1), children and legacy
 * table cells included.
 * @param blocks - The blocks.
 * @returns They, escaped.
 */
function escapedForMarkdown(blocks: readonly BlockLike[]): BlockLike[] {
  return (blocks as readonly Read[]).map((block): Read => {
    const children = escapedForMarkdown(block.children ?? []) as Read[];
    if (block.type === CODE && Array.isArray(block.content)) {
      return { ...block, content: (block.content as Inline[]).map((c) => ({ ...c, text: escapeCode(c.text ?? '') })), children };
    }
    if (Array.isArray(block.content)) return { ...block, content: escapeContent(block.content as Inline[]), children };
    const table = block.content as { type?: string; rows?: Array<{ cells: Array<{ content?: Inline[] } | Inline[]> }> } | undefined;
    if (table?.type === 'tableContent') {
      const rows = (table.rows ?? []).map((row) => ({
        ...row,
        cells: row.cells.map((cell) => (Array.isArray(cell) ? escapeContent(cell) : { ...cell, content: escapeContent(cell.content ?? []) })),
      }));
      return { ...block, content: { ...table, rows }, children };
    }
    return { ...block, children };
  });
}

/**
 * Blocks with their words escaped for a table written as HTML, against each
 * step of the way back (`fixedInline`) that HTML does not undo itself: a
 * backslash is doubled outside code, `&` is spelled `&amp;`, a link's
 * address is escaped the same way, and a space right after a hard break, in
 * the same piece or the next, is spelled as an entity. Markdown escapes do
 * nothing here.
 * @param blocks - The blocks.
 * @returns They, escaped.
 */
function escapedForHtml(blocks: readonly BlockLike[]): BlockLike[] {
  return (blocks as readonly Read[]).map((block) => {
    const code = block.type === CODE;
    let afterBreak = false;
    /**
     * One piece's words, read in order across the block.
     * @param piece - The piece.
     * @returns It, escaped.
     */
    const one = (piece: Inline): Inline => {
      if (piece.type === 'link') {
        // The way back takes the address through the same steps as words.
        return { ...piece, href: (piece.href ?? '').replace(/\\/g, '\\\\').replace(/&/g, '&amp;'), content: (piece.content ?? []).map(one) };
      }
      if (piece.type !== 'text') {
        afterBreak = false;
        return piece;
      }
      const text = piece.text ?? '';
      const words = (code || piece.styles?.['code'] === true ? text : text.replace(/\\/g, '\\\\')).replace(/&/g, '&amp;');
      const kept = code ? words : words.replace(/\n /g, `\n${entity(' ')}`).replace(/^ /, afterBreak ? entity(' ') : ' ');
      if (text !== '') afterBreak = text.endsWith('\n');
      return { ...piece, text: kept };
    };
    return {
      ...block,
      content: Array.isArray(block.content) ? (block.content as Inline[]).map(one) : block.content,
      children: escapedForHtml(block.children ?? []) as Read[],
    };
  });
}

/**
 * Escapes blocks' words for where `blocksMarkdown` writes them.
 * @param blocks - The blocks.
 * @param into - As Markdown, or into a table's HTML.
 * @returns They, escaped.
 */
function escapedFor(blocks: readonly BlockLike[], into: 'markdown' | 'html'): BlockLike[] {
  return into === 'markdown' ? escapedForMarkdown(blocks) : escapedForHtml(blocks);
}

/** The words a range leaves of a line at one of its ends, with the line's block to keep them in. */
interface LineCut {
  /** Where the line's block starts. */
  readonly at: number;
  readonly container: ProseMirrorNode;
  readonly line: ProseMirrorNode;
  /** The words outside the range. */
  readonly words: Fragment;
}

/** Where a range lies (§5.3, §5.4). */
type Span =
  /** Words inside one line of a legacy table's cell. */
  | { readonly kind: 'cell'; readonly from: number; readonly to: number }
  /** Words inside one code block, all of them included. */
  | { readonly kind: 'code'; readonly from: number; readonly to: number; readonly line: ProseMirrorNode }
  /** Whole blocks from the first block's start to the end of the last's own content. */
  | { readonly kind: 'blocks'; readonly from: number; readonly to: number; readonly first: number; readonly last: number }
  /** Words cut out of a line at one end or both (Plate's open slice). */
  | {
      readonly kind: 'words';
      readonly from: number;
      readonly to: number;
      readonly first: number;
      readonly last: number;
      /** The words before the range; null when it starts at the edge of a block without words. */
      readonly before: LineCut | null;
      /** The words after the range; null when it ends at the edge of a block without words. */
      readonly after: LineCut | null;
    };

/**
 * One end of a range against the block it is in: the block, and the line of
 * words it cuts with the words left outside; no line at the edge of a block
 * without words.
 * @param doc - The body.
 * @param pos - The end.
 * @param side - Which end.
 * @returns The block and the cut.
 */
function endOf(doc: ProseMirrorNode, pos: number, side: 'start' | 'end'): { block: number; cut: LineCut | null } {
  const $pos = doc.resolve(pos);
  let block: number;
  let offset: number | null;
  if ($pos.parent.isTextblock) {
    block = $pos.before($pos.depth - 1);
    offset = $pos.parentOffset;
  } else if (side === 'start') {
    block = pos;
    offset = 0;
  } else {
    // A table ends the range after itself; a container's own content inside it.
    block = $pos.parent.type.name === 'blockContainer' ? $pos.before($pos.depth) : pos - $pos.nodeBefore!.nodeSize;
    offset = null;
  }
  const container = doc.nodeAt(block)!;
  const line = container.type.name === 'blockContainer' && container.firstChild!.isTextblock ? container.firstChild! : null;
  if (line === null) return { block, cut: null };
  const at = offset ?? line.content.size;
  const words = side === 'start' ? line.content.cut(0, at) : line.content.cut(at);
  return { block, cut: { at: block, container, line, words } };
}

/**
 * Whether a range's end leaves no words of its line outside it.
 * @param cut - The line it cuts; null at a block without words.
 * @returns True when nothing is left.
 */
function noWordsLeft(cut: LineCut | null): boolean {
  return cut === null || cut.words.size === 0;
}

/**
 * Where a range lies (§5.4): words inside one line of a legacy cell or of a
 * code block are those words; a range from a block's start to a block's
 * end is whole blocks (Plate `wholeTextBlocks`); any other cuts the line at
 * either end.
 * @param doc - The body.
 * @param cover - The range, as `aiCoverOf` gives it.
 * @returns The span.
 */
function spanOf(doc: ProseMirrorNode, cover: LocalRange): Span {
  const { from, to } = cover;
  const $from = doc.resolve(from);
  if ($from.parent.isTextblock && $from.sameParent(doc.resolve(to))) {
    if ($from.parent.type.name === LEGACY_CELL_LINE) return { kind: 'cell', from, to };
    if ($from.parent.type.name === CODE) return { kind: 'code', from, to, line: $from.parent };
  }
  const start = endOf(doc, from, 'start');
  const end = endOf(doc, to, 'end');
  if (noWordsLeft(start.cut) && noWordsLeft(end.cut)) return { kind: 'blocks', from, to, first: start.block, last: end.block };
  return { kind: 'words', from, to, first: start.block, last: end.block, before: start.cut, after: end.cut };
}

/**
 * The blocks a span covers, as the block API reads them: whole blocks with
 * the children inside the span, or one paragraph of the words of one line.
 * @param doc - The body.
 * @param span - The span.
 * @returns The blocks.
 */
function blocksOf(doc: ProseMirrorNode, span: Span): Read[] {
  const schema = doc.type.schema;
  const $from = doc.resolve(span.from);
  if (span.kind !== 'blocks' && $from.parent.isTextblock && $from.sameParent(doc.resolve(span.to))) {
    const cut = $from.parent.content.cut($from.parentOffset, span.to - $from.start());
    const paragraph = schema.nodes['blockContainer']!.create({ id: 'ai-range' }, [schema.nodes['paragraph']!.create(null, cut)]);
    return [nodeToBlock(paragraph, doc) as unknown as Read];
  }
  const out: Read[] = [];
  /**
   * Takes one node of the slice: a block, or a container the slice cut open
   * above the range, whose blocks under it are taken instead.
   * @param node - The node.
   */
  const take = (node: ProseMirrorNode): void => {
    if (node.type.name === 'blockContainer' && node.firstChild?.type.name === 'blockGroup') node.firstChild.forEach(take);
    else if (node.type.isInGroup(BN_BLOCK)) out.push(nodeToBlock(node, doc) as unknown as Read);
  };
  doc.slice(span.kind === 'blocks' ? span.first : span.from, span.to).content.forEach(take);
  return out;
}

/**
 * The `selection` field a command sends (§5.1, §5.2): the range's Markdown,
 * its words escaped; part of one line as a paragraph of its words, a whole
 * line or more as its blocks, a code block's words as its code.
 * @param editor - An editor with the body's schema, for the Markdown export.
 * @param doc - The body.
 * @param cover - The range.
 * @returns The Markdown.
 */
export function aiRequest(editor: ViewedEditor, doc: ProseMirrorNode, cover: LocalRange): string {
  const span = spanOf(doc, cover);
  if (span.kind === 'code') return escapeCode(doc.textBetween(span.from, span.to));
  return blocksMarkdown(editor as never, blocksOf(doc, span), escapedFor);
}

/**
 * Whether an answer is empty (§5.3).
 * @param text - The answer.
 * @returns True when it holds only white space.
 */
export function aiAnswerEmpty(text: string): boolean {
  return text.trim() === '';
}

/**
 * Parses an answer into blocks, its words fixed (§5.1).
 * @param parser - An editor with the body's schema.
 * @param text - The answer.
 * @returns The blocks.
 */
function parsed(parser: ViewedEditor, text: string): Read[] {
  const markdown = text.replace(/\\\\/g, BACKSLASH_PAIR);
  return (parser.tryParseMarkdownToBlocks(markdown) as unknown as Read[]).map(fixedBlock);
}

/**
 * Whether a block holds inline words outside code, as the block API reads
 * it: what the first-block format applies to (Plate `openTextBlock`;
 * `holdsLine` asks the same of a written block).
 * @param block - The block.
 * @returns True for one.
 */
function holdsWords(block: Pick<Read, 'type' | 'content'>): boolean {
  return Array.isArray(block.content) && block.type !== CODE;
}

/**
 * Whether blocks hold a list item, nested ones included.
 * @param blocks - The blocks.
 * @returns True when they do.
 */
function hasListItems(blocks: readonly Read[]): boolean {
  return blocks.some((b) => LIST_ITEMS.has(b.type) || hasListItems(b.children ?? []));
}

/**
 * The styles of a block's first words.
 * @param block - The block.
 * @returns The styles; none for a block that starts with no words.
 */
function firstStyles(block: Read): Record<string, unknown> {
  const first = (block.content as Inline[])[0];
  const piece = first?.type === 'link' ? first.content?.[0] : first;
  return piece?.type === 'text' ? { ...(piece.styles ?? {}) } : {};
}

/**
 * Inline content with some styles under its own.
 * @param content - The content.
 * @param styles - The styles.
 * @returns It.
 */
function styledUnder(content: readonly Inline[], styles: Record<string, unknown>): Inline[] {
  return content.map((piece) => {
    if (piece.type === 'link') return { ...piece, content: styledUnder(piece.content ?? [], styles) };
    return piece.type === 'text' ? { ...piece, styles: { ...styles, ...(piece.styles ?? {}) } } : piece;
  });
}

/**
 * The answer's first block formatted from the range's first block, as
 * Plate's `formatAIOutput` does with `'single'` (§5.3): its kind and props,
 * unless the answer writes list items, and its first words' styles under the
 * answer's own. Only between two blocks of words outside code.
 * @param blocks - The answer's blocks.
 * @param source - The range's first block.
 * @returns The blocks.
 */
function formatted(blocks: readonly Read[], source: Read | null): Read[] {
  const [head, ...rest] = blocks;
  if (head === undefined || source === null || !holdsWords(source) || !holdsWords(head)) return [...blocks];
  // A list item's number is the landing's to decide.
  const { start: _start, ...props } = source.props ?? {};
  const own = hasListItems(blocks) ? {} : { type: source.type, props };
  return [{ ...head, ...own, content: styledUnder(head.content as Inline[], firstStyles(source)) }, ...rest];
}

/**
 * The block a range starts in, as the block API reads it.
 * @param doc - The body.
 * @param span - The span, whole blocks or words cut out of lines.
 * @returns The block.
 */
function sourceOf(doc: ProseMirrorNode, span: Span & { kind: 'blocks' | 'words' }): Read {
  return nodeToBlock(doc.nodeAt(span.first)!, doc) as unknown as Read;
}

/**
 * Reads an answer into the blocks the preview shows and insert and replace
 * write (§5.3): parsed whole, outside media left out and counted, headings
 * brought within the body's levels, the first block formatted from the
 * range's, a table inside a cell unfolded, and for a legacy cell its words
 * on lines, empty when no words are left.
 * For words inside a code block it is that code: one fence the model
 * wrapped it in taken off, the entities decoded, one code block.
 * @param parser - An editor with the body's schema.
 * @param state - The body's state, holding the range replace covers now.
 * @param text - The answer, as far as it is shown.
 * @param ourPrefix - Where our own media live.
 * @param insertBlockId - The insert block; with the range, it tells whether the answer lands in a table cell.
 * @returns The answer.
 */
export function aiAnswer(parser: ViewedEditor, state: EditorState, text: string, ourPrefix: string | null, insertBlockId: string): AiAnswer {
  if (aiAnswerEmpty(text)) return { preview: [], leftOut: 0 };
  const { doc } = state;
  const cover = aiCoverIn(state);
  const span = cover === null ? null : spanOf(doc, cover);
  if (span?.kind === 'code') {
    const code = decoded(text.replace(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/, '$1'));
    return { preview: [{ type: CODE, props: { ...span.line.attrs }, content: [{ type: 'text', text: code, styles: {} }], children: [] } as WrittenBlock], leftOut: 0 };
  }
  const { blocks, leftOut } = keepWritable(parsed(parser, text.trim()), ourPrefix);
  if (span?.kind === 'cell') {
    const content = flattened(blocks as Read[]);
    return { preview: content.length === 0 ? [] : [{ type: 'paragraph', props: {}, content, children: [] } as WrittenBlock], leftOut };
  }
  const shaped = formatted(blocks as Read[], span === null ? null : sourceOf(doc, span));
  // One preview serves both writes, so it fits a cell when either lands in one.
  const inCell = blockInTableCell(doc, insertBlockId) || (cover !== null && cellDepthOf(doc.resolve(cover.from)) > 0);
  return { preview: inCell ? blocksInContext(shaped, doc, true) : shaped, leftOut };
}

/**
 * A block with every id taken out, children included, so a copy gets new ones.
 * @param block - The block.
 * @returns The copy.
 */
function withoutIds(block: Read): Read {
  const copy: Read = { ...block, children: (block.children ?? []).map(withoutIds) };
  delete copy.id;
  return copy;
}

/** One block of a stretch laid flat, the way Plate keeps blocks: its own content and its level. */
interface Flat {
  /** The block without its children: a container with its own content only, or a table. */
  readonly node: ProseMirrorNode;
  /** How many levels below the stretch's top it sits. */
  readonly depth: number;
  /** Where it starts in the body; -1 for a block of the answer. */
  readonly pos: number;
}

/**
 * Blocks laid flat in reading order, each child one level below its parent.
 * @param nodes - The blocks, side by side.
 * @param pos - Where the first starts in the body; -1 for blocks outside it.
 * @param depth - Their level.
 * @returns The flat blocks.
 */
function laidFlat(nodes: readonly ProseMirrorNode[], pos: number, depth: number): Flat[] {
  const out: Flat[] = [];
  let at = pos;
  for (const node of nodes) {
    const group = node.type.name === 'blockContainer' && node.childCount > 1 ? node.lastChild! : null;
    out.push({ node: group === null ? node : node.copy(Fragment.from(node.firstChild)), depth, pos: at });
    if (group !== null) out.push(...laidFlat(group.content.content, at < 0 ? -1 : at + 1 + node.firstChild!.nodeSize + 1, depth + 1));
    if (at >= 0) at += node.nodeSize;
  }
  return out;
}

/**
 * Flat blocks built back into a tree: a block one level deeper than the
 * one before it is that block's child. A block can be at most one level
 * deeper than the one before it, and a table holds no children; a block
 * deeper than that is lifted to the deepest level it fits (a jump in a
 * Plate list's indent has no tree to show it in).
 * @param flat - The flat blocks.
 * @param schema - The body's schema.
 * @returns The top-level blocks.
 */
function rebuilt(flat: readonly Flat[], schema: Schema): ProseMirrorNode[] {
  interface Entry {
    readonly node: ProseMirrorNode;
    readonly depth: number;
    readonly children: Entry[];
  }
  const top: Entry[] = [];
  const open: Entry[] = [];
  for (const item of flat) {
    const before = open[open.length - 1];
    const deepest = before === undefined ? 0 : before.depth + (before.node.type.name === 'blockContainer' ? 1 : 0);
    const depth = Math.min(item.depth, deepest);
    while (open.length > 0 && open[open.length - 1]!.depth >= depth) open.pop();
    const entry: Entry = { node: item.node, depth, children: [] };
    (open[open.length - 1]?.children ?? top).push(entry);
    open.push(entry);
  }
  /**
   * One entry with its children under it.
   * @param entry - The entry.
   * @returns The block.
   */
  const built = (entry: Entry): ProseMirrorNode => (entry.children.length === 0
    ? entry.node
    : entry.node.copy(entry.node.content.addToEnd(schema.nodes['blockGroup']!.create(null, entry.children.map(built)))));
  return top.map(built);
}

/**
 * Whether a flat block holds a line of words outside code, which joins the
 * words next to it (Plate `openTextBlock`).
 * @param node - The block.
 * @returns True for one.
 */
function holdsLine(node: ProseMirrorNode): boolean {
  return node.type.name === 'blockContainer' && node.firstChild!.isTextblock && node.firstChild!.type.name !== CODE;
}

/**
 * The answer written into lines of words (§5.3, Plate's open slice): the
 * answer's first block joins the words before the range when it holds a line
 * of words, and its last the words after; otherwise the words left on that
 * side stay a block of their line's own kind, and none is left when there
 * are no words.
 * @param before - The words before the range; null at a block without words.
 * @param after - The words after the range; null at a block without words.
 * @param answer - The answer, laid flat.
 * @param afterLevel - The level of the line the words after stand in, below the first line's.
 * @returns The blocks that take the lines' place, laid flat.
 */
function wordsJoined(before: LineCut | null, after: LineCut | null, answer: readonly Flat[], afterLevel: number): Flat[] {
  /**
   * A line's own kind of block holding some words.
   * @param cut - The line.
   * @param words - The words.
   * @param id - Its block id; null for a new one, which BlockNote's `UniqueID` gives it.
   * @param depth - Its level.
   * @returns The block.
   */
  const ownBlock = (cut: LineCut, words: Fragment, id: unknown, depth = 0): Flat => ({
    node: cut.container.type.create({ ...cut.container.attrs, id }, cut.line.copy(words)),
    depth,
    pos: -1,
  });
  /**
   * Whether the words of a line and of an answer block join into one line.
   * @param cut - The line.
   * @param block - The answer block.
   * @returns True when both hold words outside code.
   */
  const joins = (cut: LineCut, block: ProseMirrorNode): boolean => cut.line.type.name !== CODE && holdsLine(block);
  const out = [...answer];
  const first = out[0]!;
  if (before !== null && joins(before, first.node)) out[0] = ownBlock(before, before.words.append(first.node.firstChild!.content), before.container.attrs['id']);
  else if (before !== null && before.words.size > 0) out.unshift(ownBlock(before, before.words, before.container.attrs['id']));
  const firstKept = out[0] !== first;
  const last = out[out.length - 1]!;
  if (after === null) return out;
  if (joins(after, answer[answer.length - 1]!.node)) {
    const words = last.node.firstChild!;
    out[out.length - 1] = { ...last, node: last.node.copy(Fragment.from(words.copy(words.content.append(after.words)))) };
  } else if (after.words.size > 0) {
    out.push(ownBlock(after, after.words, firstKept && before?.at === after.at ? null : after.container.attrs['id'], afterLevel));
  }
  return out;
}

/**
 * Writes the preview over a span (§5.3) the way Plate's flat blocks take it:
 * the stretch it touches is laid flat, the range's blocks, or the lines it
 * cuts with the blocks between, are swapped for the answer there, and the
 * stretch is built back in its place. Every block outside the range keeps
 * its level and its place in reading order, after what is written.
 * @param tr - The transaction it is written in.
 * @param span - The span, valid in `tr.doc`.
 * @param preview - The preview blocks.
 */
function writeOver(tr: Transaction, span: Span, preview: readonly WrittenBlock[]): void {
  const schema = tr.doc.type.schema;
  const head = ((preview[0] as Read | undefined)?.content ?? []) as Inline[];
  if (span.kind === 'cell') {
    // A legacy cell holds one line of words.
    tr.replaceWith(span.from, span.to, inlineContentToNodes(head as never, schema, 'paragraph'));
    return;
  }
  if (span.kind === 'code') {
    tr.insertText(head.map(wordsOf).join(''), span.from, span.to);
    return;
  }
  const answer = laidFlat(preview.map((b) => blockToNode(withoutIds(b as Read) as never, schema)), -1, 0);
  // The stretch is every subtree of the first and the last block's common
  // parent from the first's to the last's.
  const $first = tr.doc.resolve(span.first);
  const depth = $first.sharedDepth(span.last);
  const parent = $first.node(depth);
  const firstIndex = $first.index(depth);
  const lastIndex = tr.doc.resolve(span.last).index(depth);
  const from = $first.posAtIndex(firstIndex, depth);
  const to = $first.posAtIndex(lastIndex, depth) + parent.child(lastIndex).nodeSize;
  const stretch = laidFlat(parent.content.content.slice(firstIndex, lastIndex + 1), from, 0);
  const start = stretch.findIndex((item) => item.pos >= span.first);
  const level = stretch[start]!.depth;
  // The words left of the last line stay at that line's own level.
  const afterLevel = span.kind === 'words' && span.after !== null ? stretch.find((item) => item.pos === span.after!.at)!.depth - level : 0;
  const middle = span.kind === 'blocks' ? answer : wordsJoined(span.before, span.after, answer, afterLevel);
  tr.replaceWith(from, to, rebuilt([
    ...stretch.slice(0, start),
    ...middle.map((item) => ({ ...item, depth: item.depth + level })),
    ...stretch.filter((item) => item.pos > span.last),
  ], schema));
}

/**
 * How a write that landed ended.
 * @param answer - The answer written.
 * @returns The result, with the outside media left out.
 */
function written(answer: AiAnswer): AiWriteResult {
  return answer.leftOut > 0 ? { outcome: 'written', leftOut: answer.leftOut } : { outcome: 'written' };
}

/**
 * Writes an answer over what replace covers now, in one undo step.
 * @param handle - The document, mounted.
 * @param answer - The answer.
 * @param readAdmission - Reads current lifecycle and write admission synchronously.
 * @returns How it ended.
 */
export function replaceAiAnswer(
  handle: Pick<DocumentEditorHandle, 'editor'>,
  answer: AiAnswer,
  readAdmission: () => ProposalAdmission,
): AiWriteResult {
  const refusal = writeRefusal(readAdmission(), handle.editor);
  if (refusal !== null) return { outcome: refusal };
  const cover = aiCoverIn(handle.editor.prosemirrorState);
  if (cover === null) return { outcome: 'targetGone' };
  if (answer.preview.length === 0) return { outcome: 'mediaOnly', leftOut: answer.leftOut };
  const { editor } = handle;
  asOneUndoStep(undoOf(handle), () => {
    editor.transact((tr) => {
      writeOver(tr, spanOf(tr.doc, cover), answer.preview);
    });
  });
  return written(answer);
}

/**
 * Puts an answer's preview blocks under the insert block, in one undo step.
 * @param handle - The document, mounted.
 * @param blockId - The insert block.
 * @param answer - The answer.
 * @param readAdmission - Reads current lifecycle and write admission synchronously.
 * @returns How it ended.
 */
export function insertAiAnswer(
  handle: Pick<DocumentEditorHandle, 'editor'>,
  blockId: string,
  answer: AiAnswer,
  readAdmission: () => ProposalAdmission,
): AiWriteResult {
  const refusal = writeRefusal(readAdmission(), handle.editor);
  if (refusal !== null) return { outcome: refusal };
  const doc = handle.editor.prosemirrorState.doc;
  if (blockById(doc, blockId) === null) return { outcome: 'targetGone' };
  const blocks = answer.preview.map((b) => withoutIds(b as Read));
  if (blocks.length === 0) return { outcome: 'mediaOnly', leftOut: answer.leftOut };
  asOneUndoStep(undoOf(handle), () => {
    handle.editor.insertBlocks(blocks as never, blockId, 'after');
  });
  return written(answer);
}
