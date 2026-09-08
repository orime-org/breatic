// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading and writing the link under a selection.
 *
 * Kept apart from the popover that presents it: the answers here are about the
 * document, and the tests that pin them run against a real editor with no
 * React in the picture.
 */

import { getMarkRange } from '@tiptap/core';
import type { BlockNoteEditor } from '@blocknote/core';
import type { EditorState } from '@tiptap/pm/state';
import type { Mark } from '@tiptap/pm/model';
import { isAllowedUri } from '@tiptap/extension-link';

/**
 * The protocol an address is qualified with when it names none.
 *
 * Matched to what autolink gives a URL typed into the body, so the two paths
 * cannot disagree about what `example.com` means. BlockNote's vendored Link
 * extension holds that value as a private constant (`Link/link.ts:12`) and
 * offers no option to set it, so the agreement is pinned by a test rather than
 * by passing this along.
 */
export const DEFAULT_LINK_PROTOCOL = 'https';

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
 * The characters a host may hold: letters, digits, dots and hyphens.
 *
 * Everything else is a forbidden host code point under the URL standard, and
 * asking whether the parsed host stayed inside this set is what makes the check
 * below answer the same in every runtime. Measured: given `https://hello world`
 * Node's parser refuses the address outright, while the browsers' accept it and
 * percent-encode the space into the host, handing back `hello%20world` — which
 * carries a `%` and fails here.
 */
const HOST_CHARS = /^[a-z\d.-]+$/i;

/**
 * The schemes that address a host, out of the ten the extension allows.
 *
 * The other six — `mailto` `tel` `callto` `sms` `cid` `xmpp` — address a person
 * or a thing, and parse to an empty host. Asking a host question of those
 * would refuse every one of them, so the scheme is the whole answer there and
 * the extension's own check has already given it.
 *
 * They arrive by hand: measured, autolink recognises URLs and leaves a typed
 * email address as plain text, so `mailto:` reaches this check only because
 * someone wrote it out.
 */
const HOSTED_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'ftps:']);

/**
 * A scheme at the head of the string, by RFC 3986 §3.1's grammar.
 *
 * `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` before the colon. Asking for a
 * colon anywhere instead reads a scheme into strings that carry none: `8080:80`
 * has one before the colon that no scheme may start with, and left unqualified
 * it parses as nothing at all.
 */
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * Which link the given selection holds.
 *
 * Reads what the selection COVERS. A probe that reads its two endpoints
 * instead is blind between them — a selection swallowing a link whole, which
 * is what a triple-click or a select-all produces, reports no link — and it
 * over-reads beyond them, since an endpoint resting on a link's boundary
 * reports the link it is merely touching. Acting on that second answer would
 * strip a link the user never selected. Nine relative positions are pinned in
 * `document-link.test.ts`; the endpoint probe answers five of them wrongly —
 * three it misses, two it claims.
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
  const { from, to } = state.selection;
  return resolveLinkInSpan(state, from, to);
}

/**
 * Which link a span of the document holds.
 *
 * The body of {@link resolveLinkSelection}, reachable with a span that is not
 * the selection: the panel asks the same question about the span its tracked
 * link has moved to, and the two answers have to be arrived at the same way or
 * it could show one link and write to another.
 * @param state - The editor state to read.
 * @param from - Where the span starts.
 * @param to - Where it ends.
 * @returns The link the span acts on, or nulls when it holds none.
 */
export function resolveLinkInSpan(
  state: EditorState,
  from: number,
  to: number,
): LinkSelection {
  const linkType = state.schema.marks.link;
  if (!linkType) return NOTHING;

  let href: string | null = null;
  let range: LinkRange | null = null;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (range) return false;
    if (!node.isText) return true;
    const mark: Mark | undefined = node.marks.find((m) => m.type === linkType);
    if (!mark) return true;
    // The node's own start, which a selection beginning mid-link sits after.
    // That is enough because ProseMirror splits text nodes on their marks: the
    // node this callback just found the link on carries it from end to end, so
    // `getMarkRange` reads the same link from either position.
    const found = getMarkRange(state.doc.resolve(pos), linkType);
    if (!found) return true;
    range = { from: found.from, to: found.to };
    href = typeof mark.attrs.href === 'string' ? mark.attrs.href : null;
    return false;
  });

  return range ? { range, href } : NOTHING;
}

/**
 * Whether every part of a span can carry a link mark.
 *
 * Two ways a span refuses one, and asking about either alone leaves the other
 * live. A mark can exclude it: inline `code`'s spec excludes every other mark.
 * A node can refuse all marks: `codeBlock`'s content spec is `marks: ""`, and
 * that carries no `code` mark of its own, so a question about marks answers
 * "no code here" inside a code block. Measured: `setLink` over a code block
 * returns byte-identical HTML — a press that says it worked and did nothing.
 *
 * Asked of the whole span rather than of any part of it: a write that lands on
 * half of what the user selected turns one of their two words into a link.
 * @param state - The editor state to read.
 * @param from - Where the span starts.
 * @param to - Where it ends.
 * @returns True when a link written here would land everywhere.
 * @throws {never}
 */
export function canLinkSpan(state: EditorState, from: number, to: number): boolean {
  const linkType = state.schema.marks.link;
  if (!linkType) return false;

  let allowed = true;
  state.doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (!allowed) return false;
    if (!node.isText) return true;
    if (parent && !parent.type.allowsMarkType(linkType)) {
      allowed = false;
      return false;
    }
    // A link excludes itself (ProseMirror's default `excludes: "_self"`), and
    // replacing one is what the `edit` state does, so its own mark is not a
    // refusal.
    if (node.marks.some((m) => m.type !== linkType && m.type.excludes(linkType))) {
      allowed = false;
      return false;
    }
    return true;
  });
  return allowed;
}

/**
 * The editor a link is written to.
 *
 * Both writes act on a range the caller resolved, never on the selection —
 * `createLink`, the only link command BlockNote offers, marks whatever is
 * selected, and the selection is wider than the link whenever the user dragged
 * past it.
 */
export type LinkWritingEditor = Pick<
  BlockNoteEditor<never, never, never>,
  'pmSchema' | 'transact'
>;

/**
 * The meta the vendored autolink plugin looks for before it acts.
 *
 * `Link/helpers/autolink.ts:52-57` leaves a transaction carrying this alone.
 * Both writes here set it: a link mark is a document change, the text under it
 * often scans as an address, and autolink would otherwise answer a removal by
 * putting the mark straight back with its protocol downgraded.
 */
const PREVENT_AUTOLINK = 'preventAutolink';

/**
 * Put a link on the given range.
 *
 * The href is checked here rather than left to the mark: BlockNote's own
 * `createLink` adds the mark with no check at all (`StyleManager.ts:197-210`),
 * and a `javascript:` href reaching the document reaches every peer.
 * @param editor - The editor to write to.
 * @param range - The span to link, from {@link resolveLinkSelection}.
 * @param href - The href to store, already normalised.
 */
export function applyLink(
  editor: LinkWritingEditor,
  range: LinkRange,
  href: string,
): void {
  const linkType = editor.pmSchema.marks.link;
  if (!linkType || !isAllowedUri(href)) return;
  editor.transact((tr) => {
    tr.addMark(range.from, range.to, linkType.create({ href })).setMeta(
      PREVENT_AUTOLINK,
      true,
    );
  });
}

/**
 * Take the link off the given range.
 * @param editor - The editor to write to.
 * @param range - The span to unlink, from {@link resolveLinkSelection}.
 */
export function removeLink(editor: LinkWritingEditor, range: LinkRange): void {
  const linkType = editor.pmSchema.marks.link;
  if (!linkType) return;
  editor.transact((tr) => {
    tr.removeMark(range.from, range.to, linkType).setMeta(
      PREVENT_AUTOLINK,
      true,
    );
  });
}

/**
 * The href to store for what the user typed.
 *
 * Resolving a bare `breatic.ai` against the page it was typed on would give
 * the document's own address with that text appended, so it is qualified
 * instead. The stored href reaches every peer and the markdown export.
 *
 * Surrounding whitespace goes first, and it is the same trim both callers get:
 * {@link isLinkUrlShaped} runs this before judging, so a pasted ` breatic.ai`
 * is judged on the address rather than on the space a drag put in front of it.
 * @param raw - What the user typed.
 * @returns The same URL carrying a protocol, with no whitespace around it.
 */
export function normalizeLinkUrl(raw: string): string {
  const trimmed = raw.trim();
  return SCHEME.test(trimmed) ? trimmed : `${DEFAULT_LINK_PROTOCOL}://${trimmed}`;
}

/**
 * Whether what the user typed is shaped like a URL.
 *
 * Answers what the confirm button shows, so it asks both questions the write
 * itself will ask: the protocol check the extension's command applies, and
 * whether the string is shaped like an address at all.
 *
 * Parsing alone cannot answer the second one. The WHATWG parser is built to
 * accept what the real web contains, so where it meets a character a host may
 * not hold it is free to encode it and carry on, and the implementations differ
 * on which ones they refuse outright. The parsed host is asked about instead:
 * whatever route the string took through the parser, the host it produced
 * either stayed inside {@link HOST_CHARS} or did not.
 *
 * That question only applies to the schemes that address a host. For the rest
 * the scheme itself is the whole answer, and the check the extension's command
 * applies has already given it.
 *
 * The address is qualified before either question, so a path may hold what a
 * host may not — `a.example/a b` is accepted, `a b.com` is not.
 *
 * A single-label host (`breatic`) is accepted. So is a bare address carrying a
 * port, provided it names its protocol: `example.com:8080` reads as a protocol
 * called `example.com`, which is the same thing {@link normalizeLinkUrl} reads
 * it as. An IPv6 literal and a host holding an underscore are both refused,
 * as they are by Lexical's pattern. Whether an address resolves is not a
 * question this can answer.
 * @param raw - What the user typed.
 * @returns True when it is.
 */
export function isLinkUrlShaped(raw: string): boolean {
  const candidate = normalizeLinkUrl(raw);
  if (!isAllowedUri(candidate)) return false;
  try {
    const { protocol, hostname } = new URL(candidate);
    return HOSTED_SCHEMES.has(protocol) ? HOST_CHARS.test(hostname) : true;
  } catch {
    // A string the parser refuses outright is not shaped like an address —
    // the answer this returns, not an error the caller has to handle.
    return false;
  }
}
