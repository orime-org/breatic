// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the stylesheet needs that the document does not hold.
 *
 * Three things reach the screen from here, all computed from the document and
 * never written back: recomputing on every change is what keeps opening a
 * document from touching a byte or filling a collaborator's undo stack.
 *
 * **The numbers.** BlockNote draws an ordered item's number from `data-index`,
 * written by its own indexing plugin and read by `content: var(--index) "."`.
 * Neither shape this Space needs can travel that way: a numbered heading is a
 * `heading` block, which those selectors do not match, and a level path would
 * come out as `1.1.` because the dot is welded into the rule. So the number
 * rides on `data-doc-number`, drawn by one rule in `index.css`.
 *
 * **Where a quote begins and ends.** A quote is a prop on each block, and
 * BlockNote renders that prop as `data-quoted` on its own — enough for what is
 * declared per block. Each segment of the rule reaches over its own block's
 * margins so a run reads as one line, and the two blocks at a run's ends are
 * the ones that must not: outside them is page. Those two are marked here.
 *
 * **How far in a quoted block sits.** Indentation moves the block the rule is
 * drawn on — one `blockGroup` margin per level. The stylesheet gives those
 * back and takes them again on the padding, which it can only do knowing how
 * many there are, and nothing in the DOM says: the levels are `blockGroup`
 * elements the block is nested inside. So the count rides on `--quote-depth`.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { createExtension } from '@blocknote/core';

import { computeNumbering } from '@web/spaces/document/document-numbering';
import { quoteRuns } from '@web/spaces/document/document-quote-runs';
import { QUOTED } from '@web/spaces/document/document-list-block';

/** The attribute the number is drawn from. */
const DOC_NUMBER_ATTRIBUTE = 'data-doc-number';

/**
 * The attribute the rule beside a quote is drawn from.
 *
 * It rides on the block's CONTENT element, one segment per quoted block. Why
 * the content and not the wrapper is with the code that writes it.
 */
const QUOTE_RUN_ATTRIBUTE = 'data-quoted-run';

/**
 * The attribute on the first block of a run.
 *
 * Every segment reaches up over its own block's top margin so the run reads as
 * one rule; this one does not, because what stands above it is not part of the
 * quote.
 */
const QUOTE_FIRST_ATTRIBUTE = 'data-quoted-run-first';

/**
 * The attribute on the last block of a run.
 *
 * Every segment reaches down over its own block's bottom margin so the run
 * reads as one rule; this one does not, because what stands below it is not
 * part of the quote.
 */
const QUOTE_LAST_ATTRIBUTE = 'data-quoted-run-last';

/** The attribute saying which of the three shapes a bullet draws. */
const BULLET_LEVEL_ATTRIBUTE = 'data-bullet-level';

const decorationsKey = new PluginKey<DecorationSet>('documentDecorations');

/**
 * How many levels in a block sits.
 *
 * The shape is `doc > blockGroup > blockContainer`, and each level of
 * indentation adds a `blockGroup` and a `blockContainer` under the block above
 * — so a container's depth counts two per level, starting at one.
 * @param doc - The document the position belongs to.
 * @param pos - The position before the block's container.
 * @returns Zero for a top-level block, one for a block indented under it.
 */
function indentDepth(doc: PMNode, pos: number): number {
  return (doc.resolve(pos).depth - 1) / 2;
}

/** How many shapes a bulleted list cycles through before repeating. */
const BULLET_SHAPES = 3;

/**
 * Which shape a bulleted item draws, as a number from zero.
 *
 * The run of bulleted parents above it is what counts, not how far in it sits:
 * a bullet indented under an ordered item opens a list of its own and draws
 * the first shape. The count cycles, so a fourth level draws what the first
 * does (user 2026-09-08).
 * @param doc - The document the position belongs to.
 * @param pos - The position before the block's container.
 * @returns Zero for the first level of a bulleted list, one for the next.
 */
function bulletLevel(doc: PMNode, pos: number): number {
  const at = doc.resolve(pos);
  let run = 0;
  // Ancestors alternate `blockGroup` and `blockContainer`; a container says
  // what kind of block it is through its own content node, the first child.
  for (let depth = at.depth; depth > 0; depth -= 1) {
    const node = at.node(depth);
    if (node.type.name !== 'blockContainer') continue;
    if (node.firstChild?.type.name !== 'bulletListItem') break;
    run += 1;
  }
  return run % BULLET_SHAPES;
}

/**
 * Builds one decoration per block that needs one, on the block's own content
 * node.
 *
 * Everything here is keyed by block id, which lives on the `blockContainer`,
 * while the element the stylesheet reaches is the content node one level
 * inside it — so the walk finds the container and decorates its first child.
 * A block wanting both a number and a run mark gets one decoration carrying
 * both, so what reaches the DOM does not depend on how ProseMirror merges two.
 * @param doc - The document to read.
 * @returns The decorations for this document.
 */
function blockDecorations(doc: PMNode): DecorationSet {
  // A list inside a run starts over from these (§3.4), and a run's two end
  // blocks are the segments that do not reach past the quote.
  const runs = quoteRuns(doc);
  const numbers = computeNumbering(doc, runs);
  const opens = new Set(runs.map((run) => run.ids[0]));
  const closes = new Set(runs.map((run) => run.ids[run.ids.length - 1]));

  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    // A group is what holds the next level of blocks, so it is the one thing
    // worth descending into. Everything else here is a block's own content,
    // whose text this walk has no question to ask of — and it runs on every
    // change to the document.
    if (node.type.name === 'blockGroup') {
      return true;
    }
    if (node.type.name !== 'blockContainer') {
      return false;
    }
    // A container always has one: `blockContainer` is `blockContent
    // blockGroup?` in the schema, which is also why `quoteRuns` above reaches
    // for the same child unguarded.
    const content = node.child(0);
    const id = String(node.attrs['id']);

    // What the marker rules reach, on the content element they are written
    // against.
    const onContent: Record<string, string> = {};
    const shown = numbers.get(id);
    if (shown !== undefined) {
      onContent[DOC_NUMBER_ATTRIBUTE] = shown;
    }
    if (content.type.name === 'bulletListItem') {
      onContent[BULLET_LEVEL_ATTRIBUTE] = String(bulletLevel(doc, pos));
    }

    // What the quote's rule is drawn from, on the CONTENT element. A quote
    // runs beside the words and nothing else: a block's own outer space is not
    // content, and drawing there put a rule 100.78px tall beside a heading
    // whose words are 31.19px (user 2026-09-08). The wrapper cannot carry it —
    // `.bn-block` is a flex container, which does not collapse its child's
    // margins away, so the child's 45.6px sits inside the wrapper's own box.
    //
    // Every quoted block draws its own segment, and each carries how far in it
    // sits so all of them land at one x however deep they are indented (user
    // 2026-09-07). The segments meet: each reaches over its own block's
    // margins — up over the top one and down over the bottom one — so a run
    // reads as one rule (user 2026-09-01). The two end blocks are marked
    // because they are the ones that must NOT reach past the quote: outside
    // them is page.
    if (content.attrs[QUOTED] === true) {
      onContent[QUOTE_RUN_ATTRIBUTE] = '';
      onContent['style'] = `--quote-depth:${indentDepth(doc, pos)}`;
      if (opens.has(id)) {
        onContent[QUOTE_FIRST_ATTRIBUTE] = '';
      }
      if (closes.has(id)) {
        onContent[QUOTE_LAST_ATTRIBUTE] = '';
      }
    }

    if (Object.keys(onContent).length > 0) {
      const from = pos + 1;
      decorations.push(
        Decoration.node(from, from + content.nodeSize, onContent),
      );
    }
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * The plugin that keeps those decorations in step with the document.
 * @returns The ProseMirror plugin.
 */
function decorationsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: decorationsKey,
    state: {
      // Empty by measurement, not by choice: this editor is always bound to a
      // Yjs fragment, and the document is still empty at this point — content
      // arrives afterwards as a transaction, which `apply` below picks up.
      init: () => DecorationSet.empty,
      // A caret move leaves every number and every run boundary where it was,
      // so the whole walk is skipped: this is what C10 asserts by counting
      // transactions.
      apply: (tr, previous) =>
        tr.docChanged ? blockDecorations(tr.doc) : previous,
    },
    props: {
      decorations: (state: EditorState) => decorationsKey.getState(state),
    },
  });
}

/**
 * The extension that registers it, for the assembly to pass through.
 */
export const documentDecorationsExtension = createExtension(() => ({
  key: 'documentDecorations',
  prosemirrorPlugins: [decorationsPlugin()],
}) as never);
