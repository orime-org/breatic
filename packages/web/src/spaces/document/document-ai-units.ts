// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the AI output dialog sends, previews and writes (inner#1860, design
 * §4.6, §5.1–§5.3): the original range goes out as one piece of Markdown,
 * the whole answer read into blocks is the preview, and replace pastes it
 * over the range the way Plate's `replaceSelection` does.
 *
 * The escaping going out and the decoding coming back are a pair, fitted to
 * BlockNote 0.56's own Markdown exporter and parser (§5.1): the exporter
 * writes words as they are, and the parser decodes no entity, collapses runs
 * of spaces, and puts a space after every hard break.
 */

import { blockToNode, inlineContentToNodes, nodeToBlock } from '@blocknote/core';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { yUndoPluginKey } from 'y-prosemirror';

import { BLOCK_GROUP, ownContentEnd } from '@web/spaces/document/document-ai-range';
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
      if (left !== '' && right !== '' && (left !== right || last.type !== piece.type)) out.push(RUN_BREAK_PIECE);
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
      // The parser ends an address at white space and decodes nothing, and
      // the way back decodes every entity and unescapes it once: all three
      // are spelled as entities.
      const href = (c.href ?? '').replace(/&/g, '&amp;').replace(/[\\\s]/g, entity);
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
 * A block with more children after its own.
 * @param block - The block.
 * @param children - The blockGroup holding the children.
 * @returns It.
 */
function withChildren(block: ProseMirrorNode, children: ProseMirrorNode): ProseMirrorNode {
  const own = block.childCount > 1 ? block.lastChild : null;
  return own === null
    ? block.copy(block.content.addToEnd(children))
    : block.copy(block.content.replaceChild(block.childCount - 1, own.copy(own.content.append(children.content))));
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
 * Blocks with their words escaped for a table written as HTML, where
 * Markdown escapes do nothing: only a backslash and `&`, which the way back
 * reads once more than HTML does.
 * @param blocks - The blocks.
 * @returns They, escaped.
 */
function escapedForHtml(blocks: readonly BlockLike[]): BlockLike[] {
  /**
   * One piece's words.
   * @param piece - The piece.
   * @returns It, escaped.
   */
  const one = (piece: Inline): Inline => (piece.type === 'link'
    ? { ...piece, content: (piece.content ?? []).map(one) }
    : { ...piece, text: (piece.text ?? '').replace(/\\/g, '\\\\').replace(/&/g, '&amp;') });
  return (blocks as readonly Read[]).map((block) => ({
    ...block,
    content: Array.isArray(block.content) ? (block.content as Inline[]).map(one) : block.content,
    children: escapedForHtml(block.children ?? []) as Read[],
  }));
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

/** Where a range lies: the words of one line, or whole blocks. */
type Span =
  | {
      readonly kind: 'words';
      readonly from: number;
      readonly to: number;
      /** The textblock. */
      readonly line: ProseMirrorNode;
      /** Where its content starts. */
      readonly start: number;
      /** Its block's container and where it starts; null for a legacy cell's line. */
      readonly container: ProseMirrorNode | null;
      readonly containerPos: number;
    }
  | {
      readonly kind: 'blocks';
      /** Where the first block's container starts. */
      readonly first: number;
      /** Where the last block's container starts. */
      readonly last: number;
      /** The end of the last block's own content. */
      readonly to: number;
    };

/**
 * Where a range lies (§5.4): a range that starts before a block's container
 * is whole blocks; one inside a line is its words, and words covering a
 * whole block's line are that block.
 * @param doc - The body.
 * @param cover - The range.
 * @returns The span.
 */
function spanOf(doc: ProseMirrorNode, cover: LocalRange): Span {
  const at = doc.nodeAt(cover.from);
  if (at?.type.isInGroup(BLOCK_GROUP) === true) {
    const $to = doc.resolve(cover.to);
    // A table ends the range after itself; a container's own content inside it.
    const last = $to.parent.type.name === 'blockContainer' ? $to.before($to.depth) : cover.to - $to.nodeBefore!.nodeSize;
    return { kind: 'blocks', first: cover.from, last, to: cover.to };
  }
  const $from = doc.resolve(cover.from);
  const line = $from.parent;
  const start = $from.start();
  const legacy = line.type.name === LEGACY_CELL_LINE;
  const depth = $from.depth - 1;
  const containerPos = legacy ? -1 : $from.before(depth);
  if (!legacy && cover.from === start && cover.to === start + line.content.size) {
    return { kind: 'blocks', first: containerPos, last: containerPos, to: containerPos + 1 + line.nodeSize };
  }
  return { kind: 'words', from: cover.from, to: cover.to, line, start, container: legacy ? null : $from.node(depth), containerPos };
}

/**
 * The blocks a span covers, as the block API reads them: whole blocks with
 * the children inside the span, or one paragraph of the words.
 * @param doc - The body.
 * @param span - The span.
 * @returns The blocks.
 */
function blocksOf(doc: ProseMirrorNode, span: Span): Read[] {
  const schema = doc.type.schema;
  if (span.kind === 'words') {
    const cut = span.line.content.cut(span.from - span.start, span.to - span.start);
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
    else if (node.type.isInGroup(BLOCK_GROUP)) out.push(nodeToBlock(node, doc) as unknown as Read);
  };
  doc.slice(span.first, span.to).content.forEach(take);
  return out;
}

/**
 * The `selection` field a command sends (§5.1, §5.2): the range's Markdown,
 * its words escaped; words inside one line as a paragraph of them, a code
 * block's as its code.
 * @param editor - An editor with the body's schema, for the Markdown export.
 * @param doc - The body.
 * @param cover - The range.
 * @returns The Markdown.
 */
export function aiRequest(editor: ViewedEditor, doc: ProseMirrorNode, cover: LocalRange): string {
  const span = spanOf(doc, cover);
  if (span.kind === 'words' && span.line.type.name === CODE) return escapeCode(doc.textBetween(span.from, span.to));
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
 * Whether a block holds inline words outside code: what an open slice opens
 * and the first-block format applies to (Plate `openTextBlock`).
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
 * @param span - The span.
 * @returns The block; null for a legacy cell's words.
 */
function sourceOf(doc: ProseMirrorNode, span: Span): Read | null {
  if (span.kind === 'blocks') return nodeToBlock(doc.nodeAt(span.first)!, doc) as unknown as Read;
  return span.container === null ? null : (nodeToBlock(span.container, doc) as unknown as Read);
}

/**
 * Reads an answer into the blocks the preview shows and insert and replace
 * write (§5.3): parsed whole, outside media and blocks past the
 * body's levels left out, the first block formatted from the range's, a
 * table inside a cell unfolded, and for a legacy cell its words on lines.
 * @param parser - An editor with the body's schema.
 * @param doc - The body.
 * @param text - The answer, as far as it is shown.
 * @param ourPrefix - Where our own media live.
 * @param cover - What replace covers now; null once it is gone.
 * @returns The answer.
 */
export function aiAnswer(parser: ViewedEditor, doc: ProseMirrorNode, text: string, ourPrefix: string | null, cover: LocalRange | null): AiAnswer {
  if (aiAnswerEmpty(text)) return { preview: [], leftOut: 0 };
  const span = cover === null ? null : spanOf(doc, cover);
  if (span?.kind === 'words' && span.container === null) {
    return { preview: [{ type: 'paragraph', props: {}, content: flattened(parsed(parser, text.trim())), children: [] } as WrittenBlock], leftOut: 0 };
  }
  if (span?.kind === 'words' && span.line.type.name === CODE) {
    const code = decoded(text.replace(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/, '$1'));
    return { preview: [{ type: CODE, props: { ...span.line.attrs }, content: [{ type: 'text', text: code, styles: {} }], children: [] } as WrittenBlock], leftOut: 0 };
  }
  const { blocks, leftOut } = keepWritable(parsed(parser, text.trim()), ourPrefix);
  const shaped = formatted(blocks as Read[], span === null ? null : sourceOf(doc, span));
  const inCell = cover !== null && cellDepthOf(doc.resolve(cover.from)) > 0;
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

/**
 * How deep an open slice opens at one edge of the answer (Plate
 * `openTextBlock`, ProseMirror `Slice.maxOpen`): along the first or the last
 * child down to a block of words outside code, or not at all when that edge
 * reaches anything else first.
 * @param node - The answer's first or last block.
 * @param side - Which edge.
 * @returns The depth.
 */
function openDepth(node: ProseMirrorNode | undefined, side: 'start' | 'end'): number {
  let depth = 0;
  let at = node;
  while (at !== undefined && !at.isTextblock) {
    if (at.type.name !== 'blockContainer' && at.type.name !== 'blockGroup') return 0;
    depth += 1;
    at = (side === 'start' ? at.firstChild : at.lastChild) ?? undefined;
  }
  return at !== undefined && at.type.name !== CODE && depth > 0 ? depth + 1 : 0;
}

/**
 * Writes the preview over a span (§5.3).
 * @param tr - The transaction it is written in.
 * @param span - The span, valid in `tr.doc`.
 * @param preview - The preview blocks.
 */
function writeOver(tr: Transaction, span: Span, preview: readonly WrittenBlock[]): void {
  const schema = tr.doc.type.schema;
  if (span.kind === 'words' && span.container === null) {
    // A legacy cell holds one line of words.
    tr.replaceWith(span.from, span.to, inlineContentToNodes(((preview[0] as Read | undefined)?.content ?? []) as never, schema, 'paragraph'));
    return;
  }
  if (span.kind === 'words' && span.line.type.name === CODE) {
    tr.insertText(wordsOf((((preview[0] as Read | undefined)?.content ?? []) as Inline[])[0] ?? { type: 'text' }), span.from, span.to);
    return;
  }
  const nodes = preview.map((b) => blockToNode(withoutIds(b as Read) as never, schema));
  if (span.kind === 'blocks') {
    const $first = tr.doc.resolve(span.first);
    const $last = tr.doc.resolve(span.last);
    if ($first.depth === $last.depth && $first.start() === $last.start()) {
      // Whole sibling blocks (Plate `wholeTextBlocks`): swapped for the
      // preview, the last one's children kept under its last block.
      const lastBlock = tr.doc.nodeAt(span.last)!;
      const children = lastBlock.type.name === 'blockContainer' && lastBlock.childCount > 1 ? lastBlock.lastChild : null;
      if (children !== null) {
        const tail = nodes.pop()!;
        // A table holds rows, not blocks: the children follow it.
        if (tail.type.name === DOC_TABLE) nodes.push(tail, ...childrenOf(children));
        else nodes.push(withChildren(tail, children));
      }
      tr.replaceWith(span.first, span.last + lastBlock.nodeSize, nodes);
      return;
    }
  }
  // Otherwise an open slice (Plate `tx.slice.replace` with `openStart` and
  // `openEnd`): the first block of words joins the words before the range,
  // the words after join the last.
  const from = span.kind === 'words' ? span.from : textStart(tr.doc, span.first);
  const to = span.kind === 'words' ? span.to : textEnd(tr.doc, span.last);
  tr.replace(from, to, new Slice(Fragment.from(nodes), openDepth(nodes[0], 'start'), openDepth(nodes[nodes.length - 1], 'end')));
}

/**
 * A group's blocks.
 * @param group - The block group.
 * @returns Its children.
 */
function childrenOf(group: ProseMirrorNode): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  group.forEach((child) => {
    out.push(child);
  });
  return out;
}

/**
 * Where a block's words start; its container's start for a block without.
 * @param doc - The body.
 * @param containerPos - Where its container starts.
 * @returns The position.
 */
function textStart(doc: ProseMirrorNode, containerPos: number): number {
  return doc.nodeAt(containerPos)!.firstChild?.isTextblock === true ? containerPos + 2 : containerPos;
}

/**
 * Where a block's words end; its own content's end for a block without.
 * @param doc - The body.
 * @param containerPos - Where its container starts.
 * @returns The position.
 */
function textEnd(doc: ProseMirrorNode, containerPos: number): number {
  const end = ownContentEnd(doc, containerPos);
  return doc.nodeAt(containerPos)!.firstChild?.isTextblock === true ? end - 1 : end;
}

/**
 * Writes an answer over what replace covers now, in one undo step.
 * @param handle - The document, mounted.
 * @param answer - The answer.
 * @param cover - What replace covers now; null once it is gone.
 * @param readAdmission - Reads current lifecycle and write admission synchronously.
 * @returns How it ended.
 */
export function replaceAiAnswer(
  handle: Pick<DocumentEditorHandle, 'editor'>,
  answer: AiAnswer,
  cover: LocalRange | null,
  readAdmission: () => ProposalAdmission,
): AiWriteResult {
  const refusal = writeRefusal(readAdmission(), handle.editor);
  if (refusal !== null) return { outcome: refusal };
  if (cover === null) return { outcome: 'targetGone' };
  if (answer.preview.length === 0) return answer.leftOut > 0 ? { outcome: 'mediaOnly', leftOut: answer.leftOut } : { outcome: 'failed' };
  const { editor } = handle;
  asOneUndoStep(undoOf(handle), () => {
    editor.transact((tr) => {
      writeOver(tr, spanOf(tr.doc, cover), answer.preview);
    });
  });
  return answer.leftOut > 0 ? { outcome: 'written', leftOut: answer.leftOut } : { outcome: 'written' };
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
  const written = blocksInContext(answer.preview.map((b) => withoutIds(b as Read)), doc, blockInTableCell(doc, blockId));
  if (written.length === 0) return { outcome: 'mediaOnly', leftOut: answer.leftOut };
  asOneUndoStep(undoOf(handle), () => {
    handle.editor.insertBlocks(written as never, blockId, 'after');
  });
  return answer.leftOut > 0 ? { outcome: 'written', leftOut: answer.leftOut } : { outcome: 'written' };
}
