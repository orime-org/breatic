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

import { PALETTE_HUES, type PaletteHue } from '@web/lib/user-color';

/** The caret identity payload carried in awareness `user` fields. */
export interface CaretUser {
  /** Display name shown in the caret label (rendered as a text node). */
  name?: string;
  /** 6-digit hex for foreign/validator consumption (see user-color.ts). */
  color?: string;
  /** Palette hue for receiver-side token rendering (whitelisted here). */
  hue?: string;
  /**
   * Whether the user's window currently has focus (published on window
   * blur/focus). Untrusted wire data: ONLY the literal `false` dims the remote
   * caret/selection — anything else (missing / old clients) renders normally.
   */
  focused?: boolean;
}

const SIX_DIGIT_HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Resolves the CSS color a remote user's caret renders with, never trusting
 * free-form wire strings: whitelisted hue → palette token var (viewer-theme
 * adaptive); else strict 6-digit hex → as-is; else a neutral token.
 * @param user - The remote user's awareness identity payload.
 * @returns A safe CSS color value.
 */
export function safeCaretColor(user: CaretUser): string {
  if (
    typeof user.hue === 'string' &&
    (PALETTE_HUES as readonly string[]).includes(user.hue)
  ) {
    return `var(--color-palette-${user.hue as PaletteHue})`;
  }
  if (typeof user.color === 'string' && SIX_DIGIT_HEX.test(user.color)) {
    return user.color;
  }
  return 'var(--color-muted-foreground)';
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
    style: `--collab-selection-bg: color-mix(in srgb, ${safeCaretColor(user)} ${ratio}, transparent)`,
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
 * @param threshold - Clip margin (defaults to {@link LABEL_FLIP_THRESHOLD_PX}).
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
 * viewport's right before it would clip and must flip left — covers the prompt's
 * right padding + scrollbar.
 */
const LABEL_EDGE_THRESHOLD_PX = 8;

/**
 * Whether a caret's name label must flip to extend LEFT of the caret instead of
 * right: true when a left-anchored label (caret left + its width) would overflow
 * the scroll viewport's right edge and clip (B4, user 2026-07-12). Pure — the
 * caller measures.
 * @param caretLeft - The caret's left in viewport px.
 * @param labelWidth - The label's rendered width in px.
 * @param containerRight - The scroll viewport's right in viewport px.
 * @param threshold - Clip margin (defaults to {@link LABEL_EDGE_THRESHOLD_PX}).
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
    const container = caret.closest('[data-testid="generate-prompt-editor"]');
    if (!container) return;
    const caretRect = caret.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    label.classList.toggle(
      LABEL_BELOW_CLASS,
      shouldRenderLabelBelow(caretRect.top, containerRect.top),
    );
    label.classList.toggle(
      LABEL_FLIP_LEFT_CLASS,
      shouldFlipLabelLeft(
        caretRect.left,
        label.getBoundingClientRect().width,
        containerRect.right,
      ),
    );
  });
}

/**
 * Builds the caret DOM for a remote collaborator (CollaborationCaret `render`
 * option): the caret line + a floating name label, both colored via
 * {@link safeCaretColor}. The name lands as a TEXT NODE (no markup path). The
 * label renders above the caret, flipping BELOW on the first line where the
 * above position would clip at the scroll-viewport top (D, user 2026-07-12).
 * @param user - The remote user's awareness identity payload.
 * @param clientId - The remote awareness client id (stamped as data-client-id
 * so the focus-dim awareness listener can find this caret's reused DOM).
 * @returns The caret element (label nested inside).
 */
export function renderCollabCaret(user: CaretUser, clientId?: number): HTMLElement {
  const color = safeCaretColor(user);
  const caret = document.createElement('span');
  caret.classList.add('collaboration-carets__caret');
  // Dim the whole caret+label when the collaborator's window lost focus (they
  // switched tabs/apps) — presence stays visible, activity reads as paused.
  // NOTE: this build-time branch only covers NEWLY built widgets. A PARKED
  // caret's widget is keyed by clientId and prosemirror-view reuses its DOM on
  // key equality WITHOUT re-invoking this builder, so a focused flip alone
  // never reaches here — the awareness listener in PromptEditor toggles the
  // class on the existing DOM via the data-client-id stamped below
  // (adversarial round: both flip directions were dead without it).
  if (user.focused === false) {
    caret.classList.add('collaboration-carets__caret--blurred');
  }
  if (clientId !== undefined) {
    caret.dataset.clientId = String(clientId);
  }
  caret.style.borderColor = color;
  const label = document.createElement('div');
  label.classList.add('collaboration-carets__label');
  label.style.backgroundColor = color;
  label.appendChild(
    document.createTextNode(typeof user.name === 'string' ? user.name : ''),
  );
  caret.appendChild(label);
  scheduleLabelFlip(caret, label);
  return caret;
}
