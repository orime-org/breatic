// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether an element should keep the browser's native keyboard and clipboard
 * behaviour — so editing a node body or a form field isn't hijacked by an
 * app-level shortcut.
 * @param el - The element a keyboard or clipboard event is aimed at.
 * @returns True for inputs, textareas, and contenteditable elements.
 */
export function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  // `=== true` because an element that is not an HTMLElement has no
  // `isContentEditable` at all, and the return type says boolean.
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    (el as HTMLElement).isContentEditable === true
  );
}
