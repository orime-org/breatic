// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading the system clipboard from a menu item, where no paste event hands
 * it over: the document body's table rows and columns, and the canvas pane's
 * Paste (inner#1239, inner#1537).
 */

/** The clipboard's HTML and plain text, as an async read hands them. */
export interface ClipboardText {
  readonly html: string;
  readonly plain: string;
}

/**
 * Reads the clipboard's items. Chromium hands HTML cleaned (styles dropped,
 * CSS inlined) unless asked for it as written, which is what a paste event
 * hands; other engines ignore the request.
 * @returns The items, or null when the read is refused.
 */
export async function readClipboardItems(): Promise<ClipboardItems | null> {
  try {
    // `unsanitized` is in the Clipboard API spec but not yet in TypeScript's DOM types.
    const read = navigator.clipboard.read.bind(navigator.clipboard) as (options: { unsanitized: readonly string[] }) => Promise<ClipboardItems>;
    return await read({ unsanitized: ['text/html'] });
  } catch {
    return null;
  }
}

/**
 * The first HTML and the first plain text among clipboard items.
 * @param items - The items.
 * @returns The text, each empty when no item holds it.
 * @throws {DOMException} When an item's data cannot be read.
 */
export async function clipboardTextOf(items: ClipboardItems): Promise<ClipboardText> {
  let html = '';
  let plain = '';
  for (const item of items) {
    if (html === '' && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
    if (plain === '' && item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
  }
  return { html, plain };
}

/**
 * Reads the clipboard's HTML and plain text, as a paste event hands them.
 * @returns The text, or null when the read is refused.
 */
export async function readClipboard(): Promise<ClipboardText | null> {
  const items = await readClipboardItems();
  try {
    return items === null ? null : await clipboardTextOf(items);
  } catch {
    return null;
  }
}
