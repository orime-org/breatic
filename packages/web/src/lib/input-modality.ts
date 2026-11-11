// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Records whether the user is on the keyboard or the pointer, on
 * `<html data-input-modality>`, so focus rings show only for keyboard users.
 *
 * The browser's own `:focus-visible` treats focus moved by script as visible
 * unless a pointer focused something first, so a Radix menu closed with the
 * mouse hands focus back to its trigger with a ring (#1452). `index.css`
 * rewrites Tailwind's `focus-visible` variant to also require keyboard
 * modality.
 *
 * Only a key press switches to keyboard: Tab and Escape anywhere, and any other
 * key outside an editable area. Typing, shortcuts (Ctrl / Cmd chords, Alt off
 * macOS where Option+Tab moves focus in Safari), key releases, focus events and
 * window refocus keep the current modality, as React Aria's `useFocusVisible`
 * and the WICG focus-visible polyfill do.
 */
import { isEditableTarget } from '@web/lib/is-editable-target';
import { isMac } from '@web/lib/is-mac';

export type InputModality = 'keyboard' | 'pointer';

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/**
 * Whether a key press means the user is moving around with the keyboard.
 * @param event - The keydown.
 * @returns True when it should switch to keyboard modality.
 */
function isKeyboardNavigation(event: KeyboardEvent): boolean {
  if (MODIFIER_KEYS.has(event.key)) return false;
  if (event.ctrlKey || event.metaKey || (event.altKey && !isMac())) return false;
  if (event.key === 'Tab' || event.key === 'Escape') return true;
  return !isEditableTarget(event.target instanceof Element ? event.target : null);
}

/**
 * Starts recording the input modality on the document's root element.
 * @param doc - The document to watch.
 * @returns The function that stops recording.
 */
export function installInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  /**
   * Writes the modality, touching the DOM only when it changes.
   * @param modality - The modality to record.
   */
  const set = (modality: InputModality): void => {
    if (root.dataset.inputModality !== modality) root.dataset.inputModality = modality;
  };
  /** Records a pointer press. */
  const onPointerDown = (): void => {
    set('pointer');
  };
  /**
   * Records a key press that moves around with the keyboard.
   * @param event - The keydown.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isKeyboardNavigation(event)) set('keyboard');
  };
  set('pointer');
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
  };
}
