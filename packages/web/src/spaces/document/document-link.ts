// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Reading and writing the link under a selection.
 *
 * Kept apart from the popover that presents it: the answers here are about the
 * document, and the tests that pin them run against a real editor with no
 * React in the picture.
 */

import { getMarkRange, type Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { Mark } from '@tiptap/pm/model';
import { isAllowedUri } from '@tiptap/extension-link';

import { DEFAULT_LINK_PROTOCOL } from '@web/spaces/document/document-extensions';

/** A span of the document. */
export interface LinkRange {
  from: number;
  to: number;
}

/** Which link a selection holds, if any. */
export interface LinkSelection {
  /** The full span of the one link this selection acts on. */
  range: LinkRange | null;
  /** That link's href. */
  href: string | null;
}

const NOTHING: LinkSelection = { range: null, href: null };

/**
 * Which link the given selection holds.
 *
 * Reads what the selection COVERS. A probe that reads its two endpoints
 * instead is blind between them — a selection swallowing a link whole, which
 * is what a triple-click or a select-all produces, reports no link — and it
 * over-reads beyond them, since an endpoint resting on a link's boundary
 * reports the link it is merely touching. Acting on that second answer would
 * strip a link the user never selected. Nine relative positions are pinned in
 * `document-link.test.ts`; the endpoint probe answers four of them wrongly.
 *
 * `getMarkRange` then widens the text node that was found to the whole link,
 * which is the question it does answer: how far the mark under one position
 * extends.
 *
 * A selection meeting two links takes the earlier one in document order, so a
 * backwards drag over the same pair resolves the same link.
 * @param state - The editor state to read.
 * @returns The link the selection acts on, or nulls when it holds none.
 */
export function resolveLinkSelection(state: EditorState): LinkSelection {
  const linkType = state.schema.marks.link;
  if (!linkType) return NOTHING;

  const { from, to } = state.selection;

  let href: string | null = null;
  let range: LinkRange | null = null;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (range) return false;
    if (!node.isText) return true;
    const mark: Mark | undefined = node.marks.find((m) => m.type === linkType);
    if (!mark) return true;
    // Inside the node and inside the selection both: a text node can start
    // before the selection does, and `getMarkRange` reads what sits either
    // side of the position it is given.
    const found = getMarkRange(state.doc.resolve(Math.max(pos, from)), linkType);
    if (!found) return true;
    range = { from: found.from, to: found.to };
    href = typeof mark.attrs.href === 'string' ? mark.attrs.href : null;
    return false;
  });

  return range ? { range, href } : NOTHING;
}

/**
 * Put a link on the given range.
 *
 * Goes through the extension's own command, which carries two things a bare
 * transaction does not: the meta that stops autolink re-linking what was just
 * written, and the URI check. Setting the selection to the range first is what
 * lets the command act on the whole link while leaving the rest of what the
 * user selected alone.
 * @param editor - The editor to write to.
 * @param range - The span to link, from {@link resolveLinkSelection}.
 * @param href - The href to store, already normalised.
 */
export function applyLink(editor: Editor, range: LinkRange, href: string): void {
  editor.chain().setTextSelection(range).setLink({ href }).run();
}

/**
 * Take the link off the given range.
 *
 * Through the extension's command for the same reason {@link applyLink} is:
 * measured, a bare `removeMark` over link text ending in a space leaves the
 * mark in place, autolink having put it straight back with its protocol
 * downgraded.
 * @param editor - The editor to write to.
 * @param range - The span to unlink, from {@link resolveLinkSelection}.
 */
export function removeLink(editor: Editor, range: LinkRange): void {
  editor.chain().setTextSelection(range).unsetLink().run();
}

/**
 * The href to store for what the user typed.
 *
 * Resolving a bare `breatic.ai` against the page it was typed on would give
 * the document's own address with that text appended, so it is qualified
 * instead. The stored href reaches every peer and the markdown export.
 * @param raw - What the user typed.
 * @returns The same URL carrying a protocol.
 */
export function normalizeLinkUrl(raw: string): string {
  return raw.includes(':') ? raw : `${DEFAULT_LINK_PROTOCOL}://${raw}`;
}

/**
 * Whether what the user typed is shaped like a URL.
 *
 * Answers what the confirm button shows, so it asks both questions the write
 * itself will ask: the protocol check the extension's command applies, and
 * whether the string parses at all. Either alone lets something through that
 * the write then drops in silence — `htp:/breatic` parses, and a URL carrying
 * a space does not.
 *
 * A single-label host (`breatic`) is accepted, as it is by both editors this
 * control was modelled on. Whether an address resolves is not a question this
 * can answer.
 * @param raw - What the user typed.
 * @returns True when it is.
 */
export function isLinkUrlShaped(raw: string): boolean {
  const candidate = normalizeLinkUrl(raw);
  if (!isAllowedUri(candidate)) return false;
  try {
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
}
