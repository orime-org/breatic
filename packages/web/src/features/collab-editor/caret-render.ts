// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Receiver-side renderer for remote collaborator carets (batch-2 item 14).
 *
 * The awareness payload is UNTRUSTED wire data from other clients. The
 * CollaborationCaret default render inlines `user.color` straight into a
 * style attribute — a hostile collaborator could smuggle extra declarations
 * (`;background:url(...)` = request beacon) through it. This renderer never
 * inlines raw remote strings: it renders from the WHITELISTED palette hue
 * (which also makes the color viewer-theme adaptive — each client resolves
 * the token var against its own light/dark values), falls back to the wire
 * color only when it matches the strict 6-digit-hex shape, and otherwise
 * uses a neutral token.
 */

import { userPaletteHue, type PaletteHue } from '@web/lib/user-color';

/**
 * The caret identity payload carried in awareness `user` fields.
 *
 * Identity is the user id and nothing else (#1882). The name is resolved on
 * the receiving side from the project member roster, and the colour is derived
 * from the id — so two clients cannot disagree about either, and a peer's
 * awareness state has no free-form string that reaches the DOM.
 */
export interface CaretUser {
  /** The collaborator's user id — the only identity on the wire. */
  id?: string;
  /**
   * Whether the user's window currently has focus (published on window
   * blur/focus). Untrusted wire data: ONLY the literal `false` dims the remote
   * caret/selection — anything else (missing / old clients) renders normally.
   */
  focused?: boolean;
}

/**
 * Resolve a collaborator's display name from their user id.
 *
 * Returns null when the roster cannot name them — either it has not arrived
 * yet or the entry carries a blank name (the roster merge fills `''` for a
 * member whose profile query is still in flight, so "unknown" and "known but
 * blank" reach this contract through the same door and mean the same thing).
 */
export type ResolveCollaboratorName = (userId: string) => string | null;

/**
 * The CSS colour a remote user's caret renders with, derived from their user
 * id so both ends compute the same value without publishing one.
 *
 * `userPaletteHue` only ever returns a whitelisted hue, so the result is a
 * theme token and never a string that came off the wire — the caret and
 * selection style attributes have no injection door left to close.
 * @param user - The remote user's awareness identity payload.
 * @returns A palette token var, or a neutral token when there is no id.
 */
export function caretColor(user: CaretUser): string {
  if (typeof user.id !== 'string' || user.id.length === 0) {
    return 'var(--color-muted-foreground)';
  }
  return `var(--color-palette-${userPaletteHue(user.id) as PaletteHue})`;
}

/**
 * Builds the SELECTION-highlight decoration attrs for a remote collaborator
 * (CollaborationCaret `selectionRender` option). The extension's default
 * builder inlines the raw remote `user.color` into the style attribute — the
 * same injection door the cursor render closes, so this override must exist
 * alongside it (adversarial round-1 HIGH). Translucency comes from color-mix
 * so the safe color can stay a token var.
 * @param user - The remote user's awareness identity payload.
 * @returns The selection decoration attributes.
 */
export function renderCollabSelection(user: CaretUser): {
  style: string;
  class: string;
} {
  // A blurred collaborator's selection dims via a LOWER mix ratio (not CSS
  // opacity — the decoration class sits on the selected TEXT's wrapper, so
  // opacity would fade the user's own words).
  const ratio = user.focused === false ? '12%' : '25%';
  return {
    // Expose the per-user color ONLY as a CSS custom property — NO direct
    // background-color. index.css then decides the SHAPE per element: a plain
    // RECTANGLE on text selection, but only the ROUNDED PILL on a chip (never the
    // chip's rectangular NodeView wrapper, which carries this class + radius 0).
    // Without this, the wrapper's own background drew a rectangle over the rounded
    // pill (B, user 2026-07-13). A custom property inherits through the whole
    // subtree, so the pill picks up the color regardless of wrapper nesting.
    style: `--collab-selection-bg: color-mix(in srgb, ${caretColor(user)} ${ratio}, transparent)`,
    class: 'collaboration-carets__selection',
  };
}

/** Modifier class flipping the name label BELOW its caret (index.css). */
const LABEL_BELOW_CLASS = 'collaboration-carets__label--below';
/**
 * How close (px) the caret's top may be to the editor's scroll-viewport top
 * before the above-label would clip and must flip below. Covers a caret on the
 * first line (top padding + a margin) but not the second.
 */
const LABEL_FLIP_THRESHOLD_PX = 20;

/**
 * Whether a caret's name label must render BELOW it instead of above: true when
 * the caret sits within `threshold` px of the scroll viewport's top, where an
 * above-label would clip (D, user 2026-07-12). Pure — the caller measures.
 * @param caretTop - The caret's top in viewport px.
 * @param containerTop - The scroll viewport's top in viewport px.
 * @param threshold - Clip margin (defaults to `LABEL_FLIP_THRESHOLD_PX`).
 * @returns True when the label should flip below.
 */
export function shouldRenderLabelBelow(
  caretTop: number,
  containerTop: number,
  threshold: number = LABEL_FLIP_THRESHOLD_PX,
): boolean {
  return caretTop - containerTop < threshold;
}

/** Modifier class flipping the name label to extend LEFT of its caret (index.css). */
const LABEL_FLIP_LEFT_CLASS = 'collaboration-carets__label--flip-left';
/**
 * How close (px) a left-anchored label's right edge may come to the scroll
 * viewport's visible-content right before it would clip and must flip left —
 * covers the prompt's right padding (any scrollbar gutter is excluded by the
 * caller's clientWidth-based measurement, #1773).
 */
const LABEL_EDGE_THRESHOLD_PX = 8;

/**
 * Whether a caret's name label must flip to extend LEFT of the caret instead of
 * right: true when a left-anchored label (caret left + its width) would overflow
 * the scroll viewport's right edge and clip (B4, user 2026-07-12). Pure — the
 * caller measures.
 * @param caretLeft - The caret's left in viewport px.
 * @param labelWidth - The label's rendered width in px.
 * @param containerRight - The scroll viewport's visible-content right edge in
 * viewport px (excludes the scrollbar gutter).
 * @param threshold - Clip margin (defaults to `LABEL_EDGE_THRESHOLD_PX`).
 * @returns True when the label should flip left.
 */
export function shouldFlipLabelLeft(
  caretLeft: number,
  labelWidth: number,
  containerRight: number,
  threshold: number = LABEL_EDGE_THRESHOLD_PX,
): boolean {
  return caretLeft + labelWidth > containerRight - threshold;
}

/**
 * After the caret mounts, flips its label (a) BELOW the caret when a first-line
 * caret would clip the above-label at the scroll-viewport top (D), and (b) to
 * the LEFT of the caret when a right-extending label would clip at the viewport
 * right edge (B4). Re-runs on every caret render (y-prosemirror re-renders on
 * each move), so the label tracks the caret. The width measurement is invariant
 * to the current flip state, so the decision is stable.
 * @param caret - The caret element (already built).
 * @param label - The name label to toggle.
 */
function scheduleLabelFlip(caret: HTMLElement, label: HTMLElement): void {
  if (typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => {
    // The nearest scroll viewport — the element that actually clips, and the
    // one whose edges the label must stay inside. Found by Radix's viewport
    // attribute rather than by any one editor's test id, so every editor that
    // scrolls inside a `ScrollArea` gets the flip: the canvas prompt and the
    // document body alike. Keying it to a single editor's test id silently
    // disabled the flip everywhere else — the lookup missed and the function
    // returned early, leaving first-line labels clipped.
    const container = caret.closest('[data-radix-scroll-area-viewport]');
    if (!container) return;
    const caretRect = caret.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    label.classList.toggle(
      LABEL_BELOW_CLASS,
      shouldRenderLabelBelow(caretRect.top, containerRect.top),
    );
    // Visible-content right edge, NOT containerRect.right: the border-box
    // right includes the scrollbar gutter whenever one takes layout space
    // (overlay scrollbars normally don't, but macOS "always show scrollbars"
    // renders classic ones that do, #1773) — content, and therefore the
    // label, cannot render there.
    const contentRight = containerRect.left + container.clientLeft + container.clientWidth;
    label.classList.toggle(
      LABEL_FLIP_LEFT_CLASS,
      shouldFlipLabelLeft(caretRect.left, label.getBoundingClientRect().width, contentRight),
    );
  });
}

/**
 * Builds the caret DOM for a remote collaborator (CollaborationCaret `render`
 * option): the caret line + a floating name label, both colored via
 * {@link caretColor}. The name lands as a TEXT NODE (no markup path). The
 * label renders above the caret, flipping BELOW on the first line where the
 * above position would clip at the scroll-viewport top (D, user 2026-07-12).
 *
 * The name comes from `resolveName`, not from the wire (#1882). When that
 * returns null the caret renders as a bare coloured line with NO label — the
 * roster is fetched rather than broadcast, so a caret can legitimately appear
 * before its owner's name is known, and an empty label would flash a coloured
 * box with nothing in it. The name arrives later by DOM mutation rather than
 * by a rebuild, for the same reason the focus dim does (see the note below).
 * @param user - The remote user's awareness identity payload.
 * @param clientId - The remote awareness client id (stamped as data-client-id
 * so the focus-dim and roster listeners can find this caret's reused DOM).
 * @param resolveName - Looks the collaborator's display name up by user id.
 * @returns The caret element (label nested inside, when the name is known).
 */
export function renderCollabCaret(
  user: CaretUser,
  clientId?: number,
  resolveName?: ResolveCollaboratorName,
): HTMLElement {
  const color = caretColor(user);
  const caret = document.createElement('span');
  caret.classList.add('collaboration-carets__caret');
  // Dim the whole caret+label when the collaborator's window lost focus (they
  // switched tabs/apps) — presence stays visible, activity reads as paused.
  // NOTE: this build-time branch only covers NEWLY built widgets. A PARKED
  // caret's widget is keyed by clientId and prosemirror-view reuses its DOM on
  // key equality WITHOUT re-invoking this builder, so a focused flip alone
  // never reaches here — the awareness listener in `use-collab-caret-presence`
  // toggles the class on the existing DOM via the data-client-id stamped below
  // (adversarial round: both flip directions were dead without it).
  if (user.focused === false) {
    caret.classList.add('collaboration-carets__caret--blurred');
  }
  if (clientId !== undefined) {
    caret.dataset.clientId = String(clientId);
  }
  caret.style.borderColor = color;
  const name =
    typeof user.id === 'string' && resolveName ? resolveName(user.id) : null;
  applyCaretName(caret, name, color);
  return caret;
}

/** Class of the floating name label nested inside a caret. */
const LABEL_CLASS = 'collaboration-carets__label';

/**
 * Bring a caret's name label in line with the name we can currently resolve:
 * create it, update its text, or remove it when the name is unknown.
 *
 * Both writers go through here — the builder above on a fresh caret, and the
 * roster listener in `use-collab-caret-presence` on a caret already in the
 * DOM. One function because the two must agree on what "no name" looks like;
 * writing the removal in one place and the creation in the other is how a
 * caret ends up with a stale label nobody clears.
 * @param caret - The caret element.
 * @param name - The resolved display name, or null when it is not known.
 * @param color - The caret's colour, used when the label has to be created.
 */
export function applyCaretName(
  caret: HTMLElement,
  name: string | null,
  color: string,
): void {
  const existing = caret.querySelector<HTMLElement>(`.${LABEL_CLASS}`);
  if (name === null || name.length === 0) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.textContent = name;
    return;
  }
  const label = document.createElement('div');
  label.classList.add(LABEL_CLASS);
  label.style.backgroundColor = color;
  // A text node, never markup: the name is server data but it travels through
  // the roster, and the caret is the one place it lands in the DOM.
  label.appendChild(document.createTextNode(name));
  caret.appendChild(label);
  scheduleLabelFlip(caret, label);
}
