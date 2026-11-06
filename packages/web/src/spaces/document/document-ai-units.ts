// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The text units of the AI output dialog (inner#1860, design §4.6, §5.1–§5.3):
 * every block of the original range that holds selected words is one unit,
 * and so is every cell of a legacy table. The units are what is sent, what
 * the answer is read back into, what the preview shows and what replace
 * writes over, all from one computation (`unitSpan`).
 *
 * The request and the answer are numbered tags, `<u id="1" kind="heading">…</u>`,
 * holding Markdown. The escaping going out and the decoding coming back are a
 * pair, fitted to BlockNote 0.56's own Markdown exporter and parser (§5.1): the
 * parser decodes no entity, collapses runs of spaces, swallows raw HTML and
 * puts a space after every hard break.
 */

import { blockToNode, inlineContentToNodes, nodeToBlock } from '@blocknote/core';
import type { Fragment, Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { Transform } from '@tiptap/pm/transform';
import { yUndoPluginKey } from 'y-prosemirror';

import type { AiUnitRanges } from '@web/spaces/document/document-ai-range';
import type { AiCommand } from '@web/spaces/document/document-ai-session';
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
import { blockInTableCell, cellDepthOf, DOC_TABLE, tableAround } from '@web/spaces/document/document-table-nodes';

/** One unit: a block holding selected words, or one cell of a legacy table. */
export interface AiTextUnit {
  /** Its number in the request, from 1 in document order. */
  readonly id: number;
  /** The block's id; for a legacy table cell, the table's. */
  readonly blockId: string;
  /** The block's type; `tableCell` for a legacy table cell. */
  readonly kind: string;
  /** Which cell of a legacy table, and which of its lines, or null. */
  readonly cell: { readonly row: number; readonly col: number; readonly line: number } | null;
  /** Whether the selection covered all of the block's words when it opened. */
  readonly whole: boolean;
  /** The block's props when it opened, which an answer written into it keeps. */
  readonly props: Readonly<Record<string, unknown>>;
}

/** How a write ended. */
export type AiWriteResult =
  | { readonly outcome: 'written'; readonly leftOut?: number }
  | { readonly outcome: 'mediaOnly'; readonly leftOut: number }
  | { readonly outcome: 'readOnly' | 'failed' | 'targetGone' };

/** What one unit becomes. */
export type AiUnitWrite =
  | { readonly kind: 'inline'; readonly block: WrittenBlock }
  | { readonly kind: 'blocks'; readonly blocks: readonly WrittenBlock[] }
  | { readonly kind: 'clear' };

/** One answered unit. */
export interface AiUnitResult {
  readonly unit: AiTextUnit;
  readonly write: AiUnitWrite;
}

/** An answer read into blocks. */
export interface AiAnswer {
  /** Tags were expected and no unit sent was recognised. */
  readonly formatFailed: boolean;
  /** The answered units, in document order. */
  readonly results: readonly AiUnitResult[];
  /** What the preview shows and insert writes, in order. */
  readonly preview: readonly WrittenBlock[];
  /** How many outside media were left out. */
  readonly leftOut: number;
}

/** What a legacy table cell is called as a unit. */
const LEGACY_KIND = 'tableCell';

/** A code block's type. */
const CODE = 'codeBlock';

/** The props Markdown cannot write, which a block keeps whatever the answer says. */
const KEPT_PROPS = ['quoted', 'textColor', 'backgroundColor', 'textAlignment'] as const;

/** The props Markdown writes, which decide whether an answer kept a block's kind. */
const MARKDOWN_PROPS = ['level', 'checked', 'language'] as const;

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

/** A unit's line of words in the body now. */
interface Line {
  /** The textblock. */
  readonly node: ProseMirrorNode;
  /** Where its content starts. */
  readonly start: number;
  /** The block container around it (for a legacy cell, the table's). */
  readonly container: ProseMirrorNode;
}

/** A textblock a range covers, and the stretch of it covered. */
interface Covered {
  readonly node: ProseMirrorNode;
  readonly start: number;
  readonly from: number;
  readonly to: number;
}

/**
 * The textblocks a range runs through, with the stretch of each it covers.
 * @param doc - The body.
 * @param segments - The range.
 * @returns By position.
 */
function coveredLines(doc: ProseMirrorNode, segments: readonly LocalRange[]): Map<number, Covered> {
  const out = new Map<number, Covered>();
  for (const segment of segments) {
    doc.nodesBetween(segment.from, segment.to, (node, pos) => {
      if (!node.isTextblock) return true;
      const start = pos + 1;
      const from = Math.max(segment.from, start);
      const to = Math.min(segment.to, start + node.content.size);
      if (from < to && doc.textBetween(from, to) !== '') {
        const seen = out.get(pos);
        out.set(pos, seen === undefined ? { node, start, from, to } : { ...seen, from: Math.min(seen.from, from), to: Math.max(seen.to, to) });
      }
      return false;
    });
  }
  return out;
}

/**
 * The units of a range, as it is when the dialog opens, and the stretch of
 * each, which the original range opens on.
 * @param doc - The body.
 * @param segments - The original range.
 * @returns The units, in document order, and their stretches in the same order.
 */
export function aiTextUnits(doc: ProseMirrorNode, segments: readonly LocalRange[]): { units: AiTextUnit[]; ranges: LocalRange[] } {
  const lines = [...coveredLines(doc, segments).entries()].sort(([a], [b]) => a - b).map(([, line]) => line);
  const units = lines.map((line, index): AiTextUnit => {
    const $start = doc.resolve(line.start);
    const whole = line.from === line.start && line.to === line.start + line.node.content.size;
    const place = placeAt($start);
    if (place.cell !== null) return { id: index + 1, ...place, kind: LEGACY_KIND, whole, props: {} };
    const container = $start.node($start.depth - 1);
    const block = nodeToBlock(container.type.create(container.attrs, [line.node]), doc) as unknown as Read;
    return { id: index + 1, ...place, kind: line.node.type.name, whole, props: block.props ?? {} };
  });
  return { units, ranges: lines.map((line) => ({ from: line.from, to: line.to })) };
}

/**
 * A unit as it stands now: its block, or its legacy cell and line, where its
 * selected words are, so the copies and the nesting follow them.
 * @param doc - The body now.
 * @param unit - The unit.
 * @param ranges - Every unit's pieces, where they are now.
 * @returns The unit, placed where its words are; as it opened when they are gone.
 */
function located(doc: ProseMirrorNode, unit: AiTextUnit, ranges: AiUnitRanges): AiTextUnit {
  const span = unitSpan(doc, unit, ranges);
  if (span === null) return unit;
  const place = placeAt(doc.resolve(span.from));
  return (place.cell === null) === (unit.cell === null) ? { ...unit, ...place } : unit;
}

/**
 * The block a line belongs to, or for a legacy cell line its table and its
 * row, column and line.
 * @param $at - A position in the line.
 * @returns The block's id and the cell, or null for none.
 */
function placeAt($at: ResolvedPos): Pick<AiTextUnit, 'blockId' | 'cell'> {
  const depth = $at.depth;
  return $at.parent.type.name === LEGACY_CELL_LINE
    ? { blockId: String($at.node(depth - 4).attrs['id']), cell: { row: $at.index(depth - 3), col: $at.index(depth - 2), line: $at.index(depth - 1) } }
    : { blockId: String($at.node(depth - 1).attrs['id']), cell: null };
}

/**
 * Where a unit's selected words are now: from its first piece to its last one
 * in the same line, the words typed among them included.
 * @param doc - The body now.
 * @param unit - The unit.
 * @param ranges - Every unit's pieces, where they are now.
 * @returns The span, or null when no selected word of it is left.
 */
export function unitSpan(doc: ProseMirrorNode, unit: AiTextUnit, ranges: AiUnitRanges): LocalRange | null {
  const pieces = ranges[unit.id - 1] ?? [];
  const first = pieces[0];
  if (first === undefined) return null;
  const $first = doc.resolve(first.from);
  if (!$first.parent.isTextblock) return null;
  const inLine = pieces.filter((p) => doc.resolve(p.from).sameParent($first));
  return { from: Math.min(...inLine.map((p) => p.from)), to: Math.max(...inLine.map((p) => p.to)) };
}

/**
 * The line a span sits on, and the block around it.
 * @param doc - The body.
 * @param span - The span.
 * @returns The line, and where its block starts.
 */
function lineAt(doc: ProseMirrorNode, span: LocalRange): Line & { readonly containerPos: number } {
  const $from = doc.resolve(span.from);
  let depth = $from.depth - 1;
  while ($from.node(depth).type.name !== 'blockContainer') depth -= 1;
  return { node: $from.parent, start: $from.start(), container: $from.node(depth), containerPos: $from.before(depth) };
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
  return code ? entities : entities.replace(BACKSLASHED, (c) => (c === '\\' ? '&#92;' : `\\${c}`)).replace(/:\/\//g, '&#58;//');
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
    // A hard break is spelled as an entity: the exporter drops one at a unit's
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
 * Takes the trailing newlines off an export.
 * @param markdown - BlockNote's Markdown.
 * @returns It, trimmed at the end.
 */
function exported(markdown: string): string {
  return markdown.replace(/\n+$/, '');
}

/**
 * A stretch of a line as one block of its own kind, its words only.
 * @param doc - The body.
 * @param line - The line.
 * @param from - Where the stretch starts.
 * @param to - Where it ends.
 * @returns The block, with the line block's id, type and props.
 */
function pieceOf(doc: ProseMirrorNode, line: Line, from: number, to: number): Read {
  const cut = line.node.content.cut(from - line.start, to - line.start);
  if (line.node.type.name === LEGACY_CELL_LINE) return paragraphOfLine(doc, cut);
  return nodeToBlock(doc.type.schema.nodes['blockContainer']!.create(line.container.attrs, [line.node.copy(cut)]), doc) as unknown as Read;
}

/**
 * The `selection` field a command sends: the units as numbered tags.
 * @param editor - An editor with the body's schema, for the Markdown export.
 * @param doc - The body.
 * @param units - The units.
 * @param ranges - Every unit's pieces.
 * @param command - The command.
 * @returns The tagged units.
 */
export function aiUnitsRequest(
  editor: ViewedEditor,
  doc: ProseMirrorNode,
  units: readonly AiTextUnit[],
  ranges: AiUnitRanges,
  command: AiCommand['id'],
): string {
  return units.map((unit) => {
    const span = unitSpan(doc, unit, ranges);
    const open = `<u id="${String(unit.id)}" kind="${unit.kind}">`;
    if (span === null) return `${open}</u>`;
    const piece = pieceOf(doc, lineAt(doc, span), span.from, span.to);
    let body: string;
    if (unit.kind === CODE) {
      // A line break at either end is spelled as an entity: a raw one right
      // inside the tags is the model's own layout and is taken off (codeOf).
      const code = escapeWords(doc.textBetween(span.from, span.to), true).replace(/>/g, '&gt;').replace(/^\n/, '&#10;').replace(/\n$/, '&#10;');
      body = command === 'custom' && unit.whole
        ? exported(editor.blocksToMarkdownLossy([{ type: CODE, props: piece.props, content: code }] as never))
        : code;
    } else {
      const content = escapeContent((piece.content ?? []) as Inline[]);
      const block = command === 'custom' && unit.whole && unit.cell === null
        ? { type: piece.type, props: piece.props, content, children: [] }
        : { type: 'paragraph', content };
      body = exported(editor.blocksToMarkdownLossy([block] as never));
    }
    return `${open}${body}</u>`;
  }).join('\n');
}

/**
 * Reads the units' answers out of an answer, as far as it is shown: only
 * whole tags of units sent.
 * @param text - The answer shown so far.
 * @param units - The units sent.
 * @returns Each recognised unit's answer, and whether the format failed.
 */
function unitAnswers(text: string, units: readonly AiTextUnit[]): { answers: Map<number, string>; formatFailed: boolean } {
  const sent = new Set(units.map((u) => u.id));
  const answers = new Map<number, string>();
  // A raw `<` in an answer is always a tag (the words' own are entities), so
  // a unit's words end at its closing tag or at the next opening one; the
  // last unit may still be being written, without a closing tag begun.
  const parts = text.split(/(?=<u id=")/);
  parts.forEach((part, index) => {
    const m = /^<u id="(\d+)"[^>]*>([\s\S]*)$/.exec(part);
    if (m === null) return;
    const id = Number(m[1]);
    const close = m[2]!.indexOf('</u>');
    const words = close >= 0 ? m[2]!.slice(0, close) : index === parts.length - 1 ? m[2]!.replace(/<\/?u?$/, '') : m[2]!;
    if (sent.has(id) && !answers.has(id)) answers.set(id, words);
  });
  // `<` or `<u` alone is a tag still being written, not words.
  const untagged = !/<u[\s>]/.test(text) && !/^\s*<u?$/.test(text);
  if (untagged && units.length === 1) return { answers: new Map([[units[0]!.id, text]]), formatFailed: false };
  return { answers, formatFailed: answers.size === 0 && text.trim() !== '' };
}

/**
 * Whether a finished answer is in the wrong format: tags were expected and
 * none of a unit sent came (§6.2 E3).
 * @param text - The whole answer.
 * @param units - The units sent.
 * @returns True when it is.
 */
export function aiFormatFailed(text: string, units: readonly AiTextUnit[]): boolean {
  return unitAnswers(text, units).formatFailed;
}

/**
 * Whether an answer leaves nothing to write: no unit sent has an answer that
 * is not blank (§5.3 "结果为空").
 * @param text - The answer.
 * @param units - The units sent.
 * @returns True when it does.
 */
export function aiAnswerEmpty(text: string, units: readonly AiTextUnit[]): boolean {
  const { answers } = unitAnswers(text, units);
  return units.every((unit) => {
    const answer = answers.get(unit.id);
    return answer === undefined || blankAnswer(unit, answer);
  });
}

/**
 * A code unit's answer as written: only the line breaks right inside the tags go.
 * @param answer - The answer.
 * @returns The code.
 */
function codeOf(answer: string): string {
  return answer.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

/**
 * Whether a unit's answer is empty: blank, or for code, nothing at all,
 * since spaces are code.
 * @param unit - The unit.
 * @param answer - Its answer.
 * @returns True when it is.
 */
function blankAnswer(unit: AiTextUnit, answer: string): boolean {
  return unit.kind === CODE && unit.cell === null ? codeOf(answer) === '' : answer.trim() === '';
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
    const reader = document.createElement('textarea');
    reader.innerHTML = whole;
    return reader.value;
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
 * A backslash before a line's block syntax, so the parser reads only inline
 * formatting (CommonMark 0.31 §4.1–4.6, §5.1, §5.2).
 * @param line - One line of an answer.
 * @returns It, its block syntax escaped.
 */
function escapeLineStart(line: string): string {
  const m = /^( {0,3})(.*)$/s.exec(line)!;
  const indent = m[1]!;
  const rest = m[2]!;
  const ordered = /^(\d{1,9})([.)])(\s|$)/.exec(rest);
  if (ordered !== null) return `${indent}${ordered[1]!}\\${rest.slice(ordered[1]!.length)}`;
  const block = /^#{1,6}(\s|$)/.test(rest)
    || rest.startsWith('>')
    || /^[-*+](\s|$)/.test(rest)
    || /^(`{3,}|~{3,})/.test(rest)
    || /^([*\-_])(\s*\1){2,}\s*$/.test(rest)
    || /^-+\s*$/.test(rest)
    || rest.startsWith('|');
  // `=` takes no backslash in this parser, so a setext underline's first one
  // is spelled as an entity and decoded with the others.
  if (/^=+\s*$/.test(rest)) return `${indent}&#61;${rest.slice(1)}`;
  return block ? `${indent}\\${rest}` : line;
}

/**
 * Parses one unit's answer into blocks.
 * @param parser - An editor with the body's schema.
 * @param text - The answer.
 * @param inlineOnly - Whether its block syntax is read as words.
 * @returns The blocks.
 */
function parsed(parser: ViewedEditor, text: string, inlineOnly: boolean): Read[] {
  let markdown = text.replace(/\\\\/g, BACKSLASH_PAIR).replace(/</g, '&lt;');
  if (inlineOnly) markdown = markdown.split('\n').map(escapeLineStart).join('\n');
  return (parser.tryParseMarkdownToBlocks(markdown) as unknown as Read[]).map(fixedBlock);
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
 * Blocks with the props Markdown cannot write taken from the unit's block.
 * @param blocks - The answer's blocks.
 * @param original - The unit's block.
 * @returns The blocks.
 */
function keepingProps(blocks: readonly Read[], original: Read): Read[] {
  return blocks.map((block) => {
    const props = { ...(block.props ?? {}) };
    for (const key of KEPT_PROPS) {
      if (key in props && original.props !== undefined && key in original.props) props[key] = original.props[key];
    }
    return { ...block, props, children: keepingProps(block.children ?? [], original) };
  });
}

/**
 * Whether an answer of one block kept the unit's kind.
 * @param unit - The unit.
 * @param block - The answer's block.
 * @param original - The unit's block.
 * @returns True when it did.
 */
function keptKind(unit: AiTextUnit, block: Read, original: Read): boolean {
  if (!unit.whole) return block.type === 'paragraph';
  if (block.type !== original.type) return false;
  return MARKDOWN_PROPS.every((key) => original.props === undefined || !(key in original.props) || original.props[key] === block.props?.[key]);
}

/**
 * The block an inline answer shows as.
 * @param original - The unit's block.
 * @param content - The answer's content.
 * @returns The block.
 */
function inlineBlock(original: Read, content: readonly Inline[]): WrittenBlock {
  return { type: original.type, props: original.props, content: joined(content), children: [] } as WrittenBlock;
}

/**
 * Blocks for where the unit stands: a table inside a cell unfolded.
 * @param blocks - The blocks.
 * @param doc - The body.
 * @param unit - The unit.
 * @returns The blocks.
 */
function inContext(blocks: readonly WrittenBlock[], doc: ProseMirrorNode, unit: AiTextUnit): WrittenBlock[] {
  return blockInTableCell(doc, unit.blockId) ? blocksInContext(blocks, doc, true) : [...blocks];
}

/** What one answered unit becomes (null: left as it was), and how many outside media it left out. */
interface UnitWritten {
  readonly write: AiUnitWrite | null;
  readonly leftOut: number;
}

/**
 * What one answered unit becomes (§5.3 "答案变成块").
 * @param parser - An editor with the body's schema.
 * @param doc - The body.
 * @param unit - The unit.
 * @param answer - Its answer, as written.
 * @param command - The command.
 * @param ourPrefix - Where our own media live.
 * @returns What it becomes.
 */
function unitWrite(
  parser: ViewedEditor,
  doc: ProseMirrorNode,
  unit: AiTextUnit,
  answer: string,
  command: AiCommand['id'],
  ourPrefix: string | null,
): UnitWritten {
  const custom = command === 'custom';
  // An empty unit means "merged into another" only under custom.
  if (blankAnswer(unit, answer)) return { write: custom ? { kind: 'clear' } : null, leftOut: 0 };
  // The block as it was when the dialog opened: what the preview showed, and
  // still there to show when the block has gone since.
  const original: Read = unit.cell === null ? { type: unit.kind, props: { ...unit.props } } : { type: 'paragraph', props: {} };
  /**
   * The unit written as inline content into its own block.
   * @param content - The content.
   * @returns The write.
   */
  const inline = (content: readonly Inline[]): UnitWritten => ({ write: { kind: 'inline', block: inlineBlock(original, content) }, leftOut: 0 });

  if (unit.kind === CODE && unit.cell === null && !(custom && unit.whole)) {
    return inline([{ type: 'text', text: decoded(codeOf(answer)), styles: {} }]);
  }
  const text = answer.trim();
  if (unit.cell !== null) return inline(flattened(parsed(parser, text, !custom)));
  if (!custom) {
    if (command === 'expand' && unit.kind === 'paragraph') {
      const parts = text.split(/\n[ \t]*\n/).filter((part) => part.trim() !== '');
      if (parts.length > 1) {
        const blocks = parts.map((part) => ({ type: 'paragraph', props: original.props, content: flattened(parsed(parser, part, true)), children: [] }));
        return { write: { kind: 'blocks', blocks: inContext(blocks, doc, unit) }, leftOut: 0 };
      }
    }
    return inline(flattened(parsed(parser, text, true)));
  }
  const { blocks, leftOut } = keepWritable(parsed(parser, text, false), ourPrefix);
  if (blocks.length === 0) return { write: null, leftOut };
  const only = blocks[0] as Read;
  if (blocks.length === 1 && keptKind(unit, only, original)) {
    const content = Array.isArray(only.content) ? (only.content as Inline[]) : [];
    return { write: { kind: 'inline', block: inlineBlock(original, content) }, leftOut };
  }
  return { write: { kind: 'blocks', blocks: inContext(keepingProps(blocks as Read[], original), doc, unit) }, leftOut };
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
 * A legacy cell's line as a paragraph block.
 * @param doc - The body.
 * @param content - The line's content, or null for none.
 * @returns The block.
 */
function paragraphOfLine(doc: ProseMirrorNode, content: Fragment | null): Read {
  const schema = doc.type.schema;
  const container = schema.nodes['blockContainer']!.create({ id: 'ai-cell' }, [schema.nodes['paragraph']!.create(null, content ?? undefined)]);
  return nodeToBlock(container, doc) as unknown as Read;
}

/**
 * A copy of a legacy table as a docTable, its answered lines holding their
 * answers and its cells keeping their spans.
 * @param doc - The body.
 * @param tableId - The table.
 * @param answered - Each answered line's block, by `row:col:line`; null for a cleared one.
 * @returns The copy, or null once the table is gone.
 */
function legacyCopy(doc: ProseMirrorNode, tableId: string, answered: ReadonlyMap<string, WrittenBlock | null>): WrittenBlock | null {
  const table = blockById(doc, tableId)?.node.firstChild;
  if (table == null) return null;
  const rows: Read[] = [];
  table.forEach((row, _rowOffset, r) => {
    const cells: Read[] = [];
    row.forEach((cell, _cellOffset, c) => {
      const lines: Read[] = [];
      cell.forEach((line, _lineOffset, l) => {
        const answer = answered.get(`${String(r)}:${String(c)}:${String(l)}`);
        const words = answer === undefined ? paragraphOfLine(doc, line.content).content : answer === null ? [] : (answer as Read).content;
        lines.push({ type: 'paragraph', content: words, children: [] });
      });
      const { colspan, rowspan, colwidth } = cell.attrs as { colspan: number; rowspan: number; colwidth: number[] | null };
      cells.push({ type: cell.type.name === 'tableHeader' ? 'docTableHeader' : 'docTableCell', props: { colspan, rowspan, colwidth }, children: lines });
    });
    rows.push({ type: 'docTableRow', children: cells });
  });
  return { type: DOC_TABLE, children: rows } as WrittenBlock;
}

/**
 * A copy of a docTable, the blocks of its answered units swapped for their answers.
 * @param doc - The body.
 * @param tableId - The table's block id.
 * @param results - Its units' results.
 * @returns The copy, or null once the table is gone.
 */
function docTableCopy(doc: ProseMirrorNode, tableId: string, results: readonly AiUnitResult[]): WrittenBlock | null {
  const found = blockById(doc, tableId);
  if (found === null) return null;
  const byId = new Map<string, AiUnitWrite>();
  for (const r of results) byId.set(r.unit.blockId, combined(byId.get(r.unit.blockId), r.write));
  /**
   * Swaps answered blocks in a list for their answers.
   * @param list - The blocks.
   * @returns The list.
   */
  const swap = (list: readonly Read[]): Read[] => list.flatMap((block) => {
    const write = block.id === undefined ? undefined : byId.get(block.id);
    const children = swap(block.children ?? []);
    if (write === undefined) return [{ ...block, children }];
    // The same placing replace does (writeUnit): an emptied block with
    // children stays, the children of a split go under its last piece.
    if (write.kind === 'clear') return children.length === 0 ? [] : [{ ...block, content: [], children }];
    if (write.kind === 'inline') return [{ ...(write.block as Read), children }];
    const pieces = (write.blocks as Read[]).map((b) => ({ ...b }));
    const last = pieces[pieces.length - 1];
    if (last !== undefined) last.children = [...(last.children ?? []), ...children];
    return pieces;
  });
  const table = nodeToBlock(found.node, doc) as unknown as Read;
  return withoutIds({ ...table, children: swap(table.children ?? []) });
}

/**
 * What two units answered in one block come to, in their order, as replace
 * writes them into the line: their words one after another, or their blocks.
 * @param earlier - The earlier unit's write, if any.
 * @param later - The later unit's write.
 * @returns The block's write.
 */
function combined(earlier: AiUnitWrite | undefined, later: AiUnitWrite): AiUnitWrite {
  if (earlier === undefined || earlier.kind === 'clear') return later;
  if (later.kind === 'clear') return earlier;
  if (earlier.kind === 'inline' && later.kind === 'inline') {
    const content = [...((earlier.block as Read).content as Inline[]), ...((later.block as Read).content as Inline[])];
    return { kind: 'inline', block: { ...earlier.block, content: joined(content) } as WrittenBlock };
  }
  /**
   * The blocks a write puts in.
   * @param w - The write.
   * @returns Its blocks.
   */
  const blocksOf = (w: AiUnitWrite & { kind: 'inline' | 'blocks' }): readonly WrittenBlock[] => (w.kind === 'inline' ? [w.block] : w.blocks);
  return { kind: 'blocks', blocks: [...blocksOf(earlier), ...blocksOf(later)] };
}

/** Where a unit stands in a table: the table and the cell. */
interface TablePlace {
  /** The table, `legacy:` before a legacy one's id. */
  readonly table: string;
  /** The cell, unique within the table. */
  readonly cell: string;
}

/**
 * Where a unit stands in a table, if it does.
 * @param doc - The body.
 * @param unit - The unit.
 * @returns Its place, or null outside a table.
 */
function tablePlace(doc: ProseMirrorNode, unit: AiTextUnit): TablePlace | null {
  if (unit.cell !== null) return { table: `legacy:${unit.blockId}`, cell: `${String(unit.cell.row)}:${String(unit.cell.col)}` };
  const found = blockById(doc, unit.blockId);
  if (found === null) return null;
  const $pos = doc.resolve(found.pos);
  const cell = cellDepthOf($pos);
  const table = cell > 0 ? tableAround($pos) : null;
  return table === null ? null : { table: String(table.node.attrs['id']), cell: String($pos.before(cell)) };
}

/**
 * What the preview shows and insert writes: each result's blocks in order.
 * The units of a table are shown as one copy of it, a legacy one as a
 * docTable, unless the selection stayed inside one of its cells: the same
 * rule that puts insert under the whole table (`aiInsertBlockId`).
 * @param doc - The body.
 * @param units - The units sent.
 * @param results - The results.
 * @param shown - The body as replace leaves it around the units: their words
 *   Enter moved to other lines taken out. Table copies are made of it.
 * @param starts - Where each unit's words start now, by its id: the order in
 *   which answers in one block are joined.
 * @returns The blocks.
 */
function previewOf(
  doc: ProseMirrorNode,
  units: readonly AiTextUnit[],
  results: readonly AiUnitResult[],
  shown: ProseMirrorNode,
  starts: ReadonlyMap<number, number>,
): WrittenBlock[] {
  const places = new Map(units.map((u) => [u.id, tablePlace(doc, u)]));
  /**
   * Whether a table's units are shown as a copy of it.
   * @param table - The table.
   * @returns True when the selection did not stay inside one of its cells.
   */
  const copied = (table: string): boolean => {
    const inTable = units.filter((u) => places.get(u.id)?.table === table);
    return inTable.length < units.length || new Set(inTable.map((u) => places.get(u.id)!.cell)).size > 1;
  };
  const out: Read[] = [];
  const done = new Set<string>();
  // Where each answered unit's answered descendants go, as replace leaves
  // them (writeUnit): under its last block, or after it when that is a table.
  const under = new Map<string, Read[]>();
  for (const r of results) {
    const place = places.get(r.unit.id) ?? null;
    if (place !== null && copied(place.table)) {
      if (done.has(place.table)) continue;
      done.add(place.table);
      const group = results
        .filter((g) => places.get(g.unit.id)?.table === place.table)
        .sort((a, b) => (starts.get(a.unit.id) ?? 0) - (starts.get(b.unit.id) ?? 0));
      let copy: WrittenBlock | null;
      if (r.unit.cell === null) {
        copy = docTableCopy(shown, place.table, group);
      } else {
        const lines = new Map<string, AiUnitWrite>();
        for (const g of group) {
          const key = `${String(g.unit.cell!.row)}:${String(g.unit.cell!.col)}:${String(g.unit.cell!.line)}`;
          lines.set(key, combined(lines.get(key), g.write));
        }
        copy = legacyCopy(shown, r.unit.blockId, new Map([...lines].map(([key, w]) => [key, w.kind === 'inline' ? w.block : null])));
      }
      if (copy !== null) out.push(copy as Read);
      continue;
    }
    const written = r.write.kind === 'inline' ? [r.write.block] : r.write.kind === 'blocks' ? r.write.blocks : [];
    const pieces = (written as Read[]).map((b) => ({ ...b, children: [...(b.children ?? [])] }));
    if (pieces.length === 0) continue;
    const list = answeredAncestor(shown, r.unit.blockId, under) ?? out;
    list.push(...pieces);
    const last = pieces[pieces.length - 1]!;
    under.set(r.unit.blockId, last.type === DOC_TABLE ? list : (last.children ??= []));
  }
  return out;
}

/**
 * Where the nearest answered unit around a unit's block puts its descendants.
 * @param doc - The body.
 * @param blockId - The unit's block.
 * @param under - Where each answered unit puts its descendants, by its block id.
 * @returns That list, or null for none.
 */
function answeredAncestor(doc: ProseMirrorNode, blockId: string, under: ReadonlyMap<string, Read[]>): Read[] | null {
  const found = blockById(doc, blockId);
  if (found === null) return null;
  const $pos = doc.resolve(found.pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const parent = under.get(String($pos.node(depth).attrs['id']));
    if (parent !== undefined) return parent;
  }
  return null;
}

/**
 * An answer, as far as it is shown, read into blocks per unit.
 * @param parser - An editor with the body's schema, for the Markdown import.
 * @param doc - The body.
 * @param sent - The units sent.
 * @param text - The answer shown so far.
 * @param command - The command.
 * @param ourPrefix - Where our own media live, or null when not known.
 * @param ranges - Every unit's pieces, where they are now.
 * @returns The answer.
 */
export function aiAnswer(
  parser: ViewedEditor,
  doc: ProseMirrorNode,
  sent: readonly AiTextUnit[],
  text: string,
  command: AiCommand['id'],
  ourPrefix: string | null,
  ranges: AiUnitRanges,
): AiAnswer {
  const { answers, formatFailed } = unitAnswers(text, sent);
  const units = sent.map((unit) => located(doc, unit, ranges));
  const results: AiUnitResult[] = [];
  let leftOut = 0;
  for (const unit of units) {
    const answer = answers.get(unit.id);
    if (answer === undefined) continue;
    const { write, leftOut: dropped } = unitWrite(parser, doc, unit, answer, command, ourPrefix);
    leftOut += dropped;
    if (write !== null) results.push({ unit, write });
  }
  const starts = new Map(results.map((r) => [r.unit.id, unitSpan(doc, r.unit, ranges)?.from ?? 0]));
  const shown = new Transform(doc);
  for (const { span, inCell } of movedOf(doc, results, ranges)) takeOutMoved(shown, span, inCell);
  return { formatFailed, results, preview: previewOf(doc, units, results, shown.doc, starts), leftOut };
}

/**
 * The answered units' selected words that Enter moved to other lines than
 * the one their answer goes in: replace takes them out, the answer standing
 * for all of a unit's words.
 * @param doc - The body now.
 * @param results - The answered units.
 * @param ranges - Every unit's pieces, where they are now.
 * @returns The words, last first.
 */
function movedOf(doc: ProseMirrorNode, results: readonly AiUnitResult[], ranges: AiUnitRanges): Array<{ span: LocalRange; inCell: boolean }> {
  return results.flatMap((r) => {
    const span = unitSpan(doc, r.unit, ranges);
    if (span === null) return [];
    const $span = doc.resolve(span.from);
    return (ranges[r.unit.id - 1] ?? [])
      .filter((piece) => !doc.resolve(piece.from).sameParent($span))
      .map((piece) => ({ span: piece, inCell: r.unit.cell !== null }));
  }).sort((a, b) => b.span.from - a.span.from);
}

/**
 * Takes out words Enter moved to a line of their own. A line left empty goes,
 * its children moving under the block before it, where the words came from;
 * a legacy cell's line stays.
 * @param tr - The change they are taken out in.
 * @param at - The words, in the body before it.
 * @param inCell - Whether they are in a legacy cell.
 */
function takeOutMoved(tr: Transform, at: LocalRange, inCell: boolean): void {
  const span = { from: tr.mapping.map(at.from, 1), to: tr.mapping.map(at.to, -1) };
  if (span.to <= span.from) return;
  const line = lineAt(tr.doc, span);
  tr.delete(span.from, span.to);
  if (inCell) return;
  const left = tr.doc.nodeAt(line.containerPos);
  if (left === null || left.firstChild?.content.size !== 0) return;
  const $line = tr.doc.resolve(line.containerPos);
  const index = $line.index();
  const before = index > 0 ? $line.parent.child(index - 1) : null;
  const children = left.childCount > 1 ? left.lastChild : null;
  if (before === null || (children !== null && before.type.name !== 'blockContainer')) return;
  if (children === null) {
    tr.delete(line.containerPos, line.containerPos + left.nodeSize);
    return;
  }
  // One deletion across the boundary joins the children to the block before
  // (to its own children, when it has some), so positions in them still map
  // for the writes after it.
  const childrenStart = line.containerPos + 1 + left.firstChild.nodeSize;
  if (before.childCount > 1) tr.delete(line.containerPos - 2, childrenStart + 1);
  else tr.delete(line.containerPos - 1, childrenStart);
}

/**
 * Whether an answer writes nothing but left outside media out, which a press
 * reports, as insert does.
 * @param answer - The answer.
 * @returns True when it does.
 */
function mediaOnly(answer: AiAnswer): boolean {
  return answer.leftOut > 0 && answer.results.every((r) => r.write.kind === 'clear');
}

/**
 * Whether replace can be pressed: every unit with a non-empty answer still
 * has selected words, or the answer held only outside media. What else the
 * body gained meanwhile is the reader's call: replace is one edit undo takes
 * back.
 * @param doc - The body now.
 * @param answer - The answer.
 * @param ranges - Every unit's pieces, where they are now.
 * @returns Whether it can.
 */
export function aiReplaceAvailable(doc: ProseMirrorNode, answer: AiAnswer, ranges: AiUnitRanges): boolean {
  if (mediaOnly(answer)) return true;
  const written = answer.results.filter((r) => r.write.kind !== 'clear');
  return written.length > 0 && written.every((r) => unitSpan(doc, r.unit, ranges) !== null);
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
 * Takes some words out of their line, and the line's block with them when
 * nothing is left in it: never a legacy cell's line.
 * @param editor - The body's editor.
 * @param tr - The transaction it is written in.
 * @param span - The words, still valid in `tr.doc`.
 * @param inCell - Whether they are in a legacy cell.
 */
function takeOut(editor: ViewedEditor, tr: Transaction, span: LocalRange, inCell: boolean): void {
  const line = lineAt(tr.doc, span);
  tr.delete(span.from, span.to);
  if (inCell) return;
  const left = tr.doc.nodeAt(line.containerPos);
  if (left !== null && left.childCount === 1 && left.firstChild?.content.size === 0) editor.removeBlocks([String(line.container.attrs['id'])]);
}

/**
 * Writes one unit's answer over its span (§5.3 "替换").
 * @param editor - The body's editor.
 * @param tr - The transaction it is written in.
 * @param result - The unit's result.
 * @param span - Its span, still valid in `tr.doc`: later units are written first.
 */
function writeUnit(editor: ViewedEditor, tr: Transaction, result: AiUnitResult, span: LocalRange): void {
  const { unit, write } = result;
  if (write.kind === 'inline') {
    // The line's type now: the reader may have turned it into code since.
    const type = unit.cell !== null ? 'paragraph' : lineAt(tr.doc, span).node.type.name;
    tr.replaceWith(span.from, span.to, inlineContentToNodes((write.block as Read).content as never, tr.doc.type.schema, type));
    return;
  }
  if (write.kind === 'clear') {
    takeOut(editor, tr, span, unit.cell !== null);
    return;
  }
  // The words before the span stay where they are, in the block with its id:
  // the units written after this one may hold some of them. The block is
  // split there as Enter splits it, and the rest is swapped for the answer
  // and the words after, as nodes: the words left out keep every mark,
  // comments included, and the children go under the last piece as they are.
  // A null id is filled in by BlockNote's id plugin in the same dispatch.
  let at = span;
  const first = lineAt(tr.doc, span);
  if (span.from > first.start) {
    tr.split(span.from, 2, [{ type: first.container.type, attrs: { ...first.container.attrs, id: null } }, { type: first.node.type, attrs: first.node.attrs }]);
    const map = tr.steps[tr.steps.length - 1]!.getMap();
    at = { from: map.map(span.from, 1), to: map.map(span.to, 1) };
  }
  const { node, start, container, containerPos } = lineAt(tr.doc, at);
  const schema = tr.doc.type.schema;
  const pieces: ProseMirrorNode[] = (write.blocks as Read[]).map((b) => blockToNode(b as never, schema));
  if (at.to < start + node.content.size) pieces.push(container.type.create({ ...container.attrs, id: null }, [node.copy(node.content.cut(at.to - start))]));
  const children = container.childCount > 1 ? container.lastChild : null;
  if (children !== null) {
    const last = pieces.pop()!;
    // A table holds rows, not blocks: the children follow it.
    if (last.type.name === DOC_TABLE) {
      pieces.push(last);
      children.forEach((child) => {
        pieces.push(child);
      });
    } else {
      pieces.push(withChildren(last, children));
    }
  }
  tr.replaceWith(containerPos, containerPos + container.nodeSize, pieces);
}

/**
 * Writes an answer over its units, last to first, in one undo step.
 * @param handle - The document, mounted.
 * @param answer - The answer.
 * @param ranges - Every unit's pieces, where they are now.
 * @param readAdmission - Reads current lifecycle and write admission synchronously.
 * @returns How it ended.
 */
export function replaceAiAnswer(
  handle: Pick<DocumentEditorHandle, 'editor'>,
  answer: AiAnswer,
  ranges: AiUnitRanges,
  readAdmission: () => ProposalAdmission,
): AiWriteResult {
  const refusal = writeRefusal(readAdmission(), handle.editor);
  if (refusal !== null) return { outcome: refusal };
  if (mediaOnly(answer)) return { outcome: 'mediaOnly', leftOut: answer.leftOut };
  const { editor } = handle;
  const before = editor.prosemirrorState.doc;
  const written = answer.results
    .map((r) => ({ r, span: unitSpan(before, r.unit, ranges) }))
    .filter((x): x is { r: AiUnitResult; span: LocalRange } => x.span !== null)
    .sort((a, b) => b.span.from - a.span.from);
  const moved = movedOf(before, answer.results, ranges);
  asOneUndoStep(undoOf(handle), () => {
    editor.transact((tr) => {
      for (const { span, inCell } of moved) takeOutMoved(tr, span, inCell);
      // Written last to first, each where the writes before it left its
      // words: a unit's words can hold another unit's once lines were joined.
      for (const { r, span } of written) {
        const at = { from: tr.mapping.map(span.from, 1), to: tr.mapping.map(span.to, -1) };
        if (at.to > at.from) writeUnit(editor, tr, r, at);
      }
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
