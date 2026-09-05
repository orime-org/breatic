// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The `> ` shorthand, which opens a quote where the caret is.
 *
 * It sits on its own rather than beside the list shorthands in
 * `document-list-block.ts`, because a quote is not a kind of block: it is a
 * prop any block can carry, so the rule keeps whatever type the block already
 * had and sets that prop. A heading typed `> ` into stays a heading.
 *
 * Registered on the EDITOR rather than on a block spec for the same reason —
 * there is no one block type it belongs to. Input rules an extension carries
 * only take effect when the editor is built with it, which is where
 * `build-document-editor.ts` passes this one.
 */

import { createExtension } from '@blocknote/core';

import { QUOTED } from '@web/spaces/document/document-list-block';

/**
 * The extension carrying the `> ` shorthand.
 *
 * The pattern matches the list shorthands next door: one optional leading
 * space, the marker, then the space that fires the rule.
 *
 * One prop and no type: `updateBlockTr` resolves the node type as
 * `block.type || blockInfo.blockNoteType` (`updateBlock.ts:86`) and merges
 * props onto what the node already carries
 * (`{ ...node.attrs, ...filteredNewAttrs }`, `:462`), so a block keeps its
 * own type and its own props by being handed neither. A level-2 heading typed
 * `> ` into stays a level-2 heading, numbered if it was numbered.
 */
export const documentQuoteInputExtension = createExtension(() => ({
  key: 'document-quote-input',
  inputRules: [{ find: /^\s?>\s$/, replace: () => ({ props: { [QUOTED]: true } }) }],
}) as never);
