// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The BlockNote schema this Space runs on.
 *
 * Three groups have to be spread explicitly: `BlockNoteSchema.create` is three
 * `??`, so handing it one group without its defaults drops the other two.
 * Dropping `inlineContentSpecs` takes `link` with it, and #903's address
 * ruling hangs off that node.
 *
 * `quoted` sits on EVERY block because a quote coexists with all nine types —
 * modelling it as a container would make it exclusive again, which is what the
 * built-in `quote` type does and why that one is removed here. A block whose
 * type never declares the prop drops it in silence: `updateBlock` filters
 * anything the target type does not list.
 *
 * `numbered` and `number` sit on `heading` because an ordered list and a
 * heading coexist, and on `numberedListItem` because a user-set number pins
 * that item. `number` is `undefined` for every block this version can
 * produce — the entry that writes it is #944.
 */

import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from '@blocknote/core';
import { createCodeBlockSpec } from '@blocknote/core/blocks';

import { buildListItemSpecs } from '@web/spaces/document/document-list-block';
import {
  unsupportedBlockSpec,
  unsupportedInlineSpec,
} from '@web/spaces/document/document-unsupported-blocknote';

/** A prop declaration in BlockNote's shape. */
type PropDecl = Readonly<Record<string, unknown>>;

/** The shape `defaultBlockSpecs` entries share, narrowed to what we extend. */
interface SpecWithProps {
  readonly config: { readonly propSchema: Record<string, PropDecl> };
}

/** Marks a block as sitting inside a quote. */
const QUOTED_PROP: Record<string, PropDecl> = {
  quoted: { default: false },
};

/** Lets a heading carry an ordered-list number. */
const NUMBERED_PROPS: Record<string, PropDecl> = {
  numbered: { default: false },
  number: { default: undefined, type: 'number' },
};

/** Lets a list item pin a user-set number. */
const NUMBER_PROP: Record<string, PropDecl> = {
  number: { default: undefined, type: 'number' },
};

/**
 * Copies a block spec with extra props merged into its propSchema.
 * @param spec - The spec to extend.
 * @param extra - Props to add.
 * @returns A new spec; the original is untouched.
 */
function withProps<T extends SpecWithProps>(
  spec: T,
  extra: Record<string, PropDecl>,
): T {
  return {
    ...spec,
    config: {
      ...spec.config,
      propSchema: { ...spec.config.propSchema, ...extra },
    },
  };
}

/**
 * Builds the schema: nine types, three added props, the rest turned off.
 * @returns The schema to hand `BlockNoteEditor.create`.
 * @throws {Error} Whatever BlockNote throws while validating the specs.
 */
export function buildDocumentSchema(): ReturnType<typeof BlockNoteSchema.create> {
  const {
    // Turned off this version — they reach the fallback path instead of the
    // menu, which could not name them. `quote` goes with them because
    // `quoted` is the model now, and two representations of one thing would
    // make the coexistence rule false for whichever came in as a container.
    quote: _quote,
    toggleListItem: _toggleListItem,
    divider: _divider,
    table: _table,
    image: _image,
    video: _video,
    audio: _audio,
    file: _file,
    ...enabled
  } = defaultBlockSpecs;

  const lists = buildListItemSpecs();
  const blockSpecs = {
    paragraph: withProps(enabled.paragraph, QUOTED_PROP),
    heading: withProps(enabled.heading, { ...QUOTED_PROP, ...NUMBERED_PROPS }),
    // Tab moves a block one level in, whatever kind of block it is (§3.3).
    // The code block's own Tab types two spaces instead, which is right for a
    // code editor and wrong for this Space's one rule.
    codeBlock: withProps(
      createCodeBlockSpec({ indentLineWithTab: false }),
      QUOTED_PROP,
    ),
    bulletListItem: withProps(lists.bulletListItem, QUOTED_PROP),
    numberedListItem: withProps(lists.numberedListItem, {
      ...QUOTED_PROP,
      ...NUMBER_PROP,
    }),
    checkListItem: withProps(lists.checkListItem, QUOTED_PROP),
    unsupportedBlock: unsupportedBlockSpec,
  };

  return BlockNoteSchema.create({
    blockSpecs,
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      unsupportedInline: unsupportedInlineSpec,
    },
    styleSpecs: { ...defaultStyleSpecs },
  } as never);
}
