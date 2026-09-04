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

import { createExtension, getBlockInfoFromSelection } from '@blocknote/core';

import { QUOTED } from '@web/spaces/document/document-list-block';

/** What this rule needs from the editor it runs in. */
interface QuoteInputEditor {
  readonly prosemirrorState: unknown;
}

/**
 * The extension carrying the `> ` shorthand.
 *
 * The pattern matches the list shorthands next door: one optional leading
 * space, the marker, then the space that fires the rule.
 */
export const documentQuoteInputExtension = createExtension(() => ({
  key: 'document-quote-input',
  inputRules: [
    {
      find: /^\s?>\s$/,
      replace({ editor }: { editor: QuoteInputEditor }) {
        const info = getBlockInfoFromSelection(
          editor.prosemirrorState as never,
        );
        // The block's own type and props go back untouched save for the one
        // this rule sets: typing the shorthand into a level-2 heading leaves a
        // level-2 heading, quoted.
        return {
          type: info.blockNoteType,
          props: {
            ...(info.isBlockContainer
              ? (info.blockContent.node.attrs as Record<string, unknown>)
              : {}),
            [QUOTED]: true,
          },
        };
      },
    },
  ],
}) as never);
