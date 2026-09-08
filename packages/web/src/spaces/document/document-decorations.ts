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
 * BlockNote renders that prop as `data-quoted` on its own — enough for the four
 * declarations that are per block. The other three belong to the whole quote
 * (its outer margins, and the two blocks whose own margins give way to them),
 * so the ends of each run are marked here.
 *
 * **How far in a quoted block sits.** The rule beside a quote is that block's
 * own border, so indentation carries it along — one `blockGroup` margin per
 * level. The stylesheet gives those back and takes them again on the padding,
 * which it can only do knowing how many there are, and nothing in the DOM
 * says: the levels are `blockGroup` elements the block is nested inside. So
 * the count rides on `--quote-depth`.
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
 * It rides on the block's WRAPPER rather than on its content, because the
 * wrapper's box is the one that already contains the space between two blocks:
 * BlockNote gives `.bn-block` `display: flex`, and a flex container does not
 * collapse its child's margins away, so a quoted block's own spacing is inside
 * the wrapper. Drawn there, the rule runs unbroken down a run while every
 * block keeps whatever spacing its own type has (user 2026-09-08).
 */
const QUOTE_RUN_ATTRIBUTE = 'data-quoted-run';

/** The attribute marking the wrapper a quote opens on. */
const QUOTE_FIRST_ATTRIBUTE = 'data-quoted-run-first';

/** The attribute marking the wrapper a quote closes on. */
const QUOTE_LAST_ATTRIBUTE = 'data-quoted-run-last';

/** The attribute saying which of the three shapes a bullet draws. */
const BULLET_LEVEL_ATTRIBUTE = 'data-bullet-level';

const decorationsKey = new PluginKey<DecorationSet>('documentDecorations');

/**
 * Whether a quoted block is indented under another quoted block.
 *
 * A quote draws ONE rule, the outermost (user 2026-09-08). A wrapper contains
 * the blocks indented under it, so the outermost one's border already runs
 * past all of them; drawing the inner ones too put a second rule 17px right of
 * the first and a third 17px right of that.
 * @param doc - The document the position belongs to.
 * @param pos - The position before the block's container.
 * @returns True when some ancestor block is quoted.
 */
function insideAnotherQuote(doc: PMNode, pos: number): boolean {
  const at = doc.resolve(pos);
  for (let depth = at.depth; depth > 0; depth -= 1) {
    const node = at.node(depth);
    if (node.type.name !== 'blockContainer') continue;
    if (node.firstChild?.attrs[QUOTED] === true) return true;
  }
  return false;
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
  // One walk: the run ends are marked from it, and a list inside a run
  // starts over from it (§3.4).
  const runs = quoteRuns(doc);
  const numbers = computeNumbering(doc, runs);

  // Which blocks carry the rule, and which of those open and close a run. Only
  // the outermost of a run are marked, and a run's own margins go on the
  // outermost at each end — the wrapper of a block indented under another sits
  // INSIDE that one's box, where a margin separates nothing.
  const outermost = new Set<string>();
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true;
    if (node.firstChild?.attrs[QUOTED] !== true) return true;
    if (!insideAnotherQuote(doc, pos)) outermost.add(String(node.attrs['id']));
    return true;
  });

  const opens = new Set<string>();
  const closes = new Set<string>();
  runs.forEach((run) => {
    const tops = run.ids.filter((id) => outermost.has(id));
    if (tops.length === 0) return;
    opens.add(tops[0]!);
    closes.add(tops[tops.length - 1]!);
  });

  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') {
      return true;
    }
    const content = node.firstChild;
    if (content === null) {
      return true;
    }
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
    if (Object.keys(onContent).length > 0) {
      const from = pos + 1;
      decorations.push(
        Decoration.node(from, from + content.nodeSize, onContent),
      );
    }

    // What the quote's rule is drawn from, on the block's wrapper.
    if (outermost.has(id)) {
      const onWrapper: Record<string, string> = { [QUOTE_RUN_ATTRIBUTE]: '' };
      if (opens.has(id)) {
        onWrapper[QUOTE_FIRST_ATTRIBUTE] = '';
      }
      if (closes.has(id)) {
        onWrapper[QUOTE_LAST_ATTRIBUTE] = '';
      }
      decorations.push(Decoration.node(pos, pos + node.nodeSize, onWrapper));
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
