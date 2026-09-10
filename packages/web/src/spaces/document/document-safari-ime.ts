// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Keeping an indented block from emptying while an input method holds it.
 *
 * WebKit's contenteditable removes an element that becomes empty during a
 * composition, and the ancestors that empty along with it, whenever that
 * element carries `position: relative`. Safari empties the composition buffer
 * before it commits a candidate — a `beforeinput`/`input` pair carrying
 * `data: ""`, which Chrome never sends — so the removal lands mid-word, and
 * `prosemirror-view` reads the changed structure back into the document as an
 * extra block. Measured by the reader in Safari (2026-09-08): the row count
 * went from 156 to 157 on that `input` event, with the candidate not yet
 * committed.
 *
 * `@blocknote/core@0.54.0` declares that property on one selector:
 *
 * ```css
 * .bn-block-group .bn-block-group > .bn-block-outer { position: relative }
 * ```
 *
 * Two nested block groups have to match, which is why a row at the left edge
 * never grew one and an indented row did.
 *
 * The bug belongs to WebKit rather than to any editor — it reproduces in a
 * bare contenteditable — and neither `prosemirror-view` nor BlockNote nor
 * TipTap handles it: ProseMirror issue #934 was still open when that
 * repository was archived in April 2026, and TipTap's #5584 is open as well.
 * What the field settled on is this plugin, which keeps a span in the block
 * for as long as a composition runs so nothing inside it is ever empty.
 *
 * `prosemirror-safari-ime-span` v1.0.2, MIT, by ocavue, built on the approach
 * jljorgenson18 arrived at in production and described on issue #934. It
 * draws nothing outside Safari: the module decides once, from the same
 * `navigator.vendor` test `prosemirror-view` itself uses.
 */

import { createExtension } from '@blocknote/core';
import { imeSpan } from 'prosemirror-safari-ime-span';

/**
 * The extension that registers the span for the whole document.
 * @returns The extension, for the assembly to register.
 */
export const documentSafariImeExtension = createExtension(() => {
  return {
    key: 'document-safari-ime',
    prosemirrorPlugins: [imeSpan],
  } as never;
});
