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
 * Builds the caret DOM for a remote collaborator (CollaborationCaret `render`
 * option): the caret line + a floating name label, both colored via
 * {@link safeCaretColor}. The name lands as a TEXT NODE (no markup path).
 * @param user - The remote user's awareness identity payload.
 * @returns The caret element (label nested inside).
 */
export function renderCollabCaret(user: CaretUser): HTMLElement {
  const color = safeCaretColor(user);
  const caret = document.createElement('span');
  caret.classList.add('collaboration-carets__caret');
  caret.style.borderColor = color;
  const label = document.createElement('div');
  label.classList.add('collaboration-carets__label');
  label.style.backgroundColor = color;
  label.appendChild(
    document.createTextNode(typeof user.name === 'string' ? user.name : ''),
  );
  caret.appendChild(label);
  return caret;
}
