// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The BlockNote schema this Space runs on.
 *
 * Three groups have to be spread explicitly: `BlockNoteSchema.create` is three
 * `??`, so handing it one group without its defaults drops the other two.
 * Dropping `inlineContentSpecs` takes `link` with it, and #903's address
 * ruling hangs off that node.
 *
 * `quoted` sits on EVERY block because a quote coexists with each of the eight
 * content rows the menu offers — quote is the ninth row itself —
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
  addNodeAndExtensionsToSpec,
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from '@blocknote/core';
import {
  createCodeBlockSpec,
  createHeadingBlockSpec,
} from '@blocknote/core/blocks';

import { buildListItemSpecs } from '@shared/document/model/document-list-block.js';
import { legacyTableSpec } from '@shared/document/model/document-table-legacy.js';
import { docTableSpecs, type DocTableView } from '@shared/document/model/document-table-nodes.js';
import {
  unsupportedBlockSpec,
  unsupportedInlineSpec,
} from '@shared/document/model/document-unsupported-blocknote.js';

/**
 * The heading levels the body carries, which is what the menu offers.
 *
 * `h3` is already 17px against a 15px paragraph and a fourth has nowhere to
 * sit; Notion and Feishu stop at three for the same reason. The schema reads
 * this to narrow BlockNote's six, so the levels a user can reach by typing
 * `### `, by `Mod-Alt-N` and by this menu are one list.
 *
 * Widening it needs a rule in `index.css` for the new level FIRST — preflight
 * resets `h1..h6` to inherit, so a level with no rule of its own renders at
 * the paragraph's size and weight. `document-heading-levels` reads the
 * stylesheet and goes red on a level that has none.
 */
export const BODY_HEADING_LEVELS = [1, 2, 3] as const;

/** A prop declaration in BlockNote's shape. */
type PropDecl = Readonly<Record<string, unknown>>;

/** The shape `defaultBlockSpecs` entries share, narrowed to what we extend. */
interface SpecWithProps {
  readonly config: { readonly propSchema: Record<string, PropDecl> };
}

/** The parts of a media block spec web's node view reads and rebuilds. */
export interface MediaBlockSpec {
  readonly config: {
    readonly type: string;
    readonly propSchema: Record<string, { readonly default?: unknown }>;
  };
  readonly implementation: {
    readonly meta?: { readonly fileBlockAccept?: readonly string[] };
  } & Record<string, unknown>;
  readonly extensions?: readonly unknown[];
}

/**
 * What the browser's editor adds to the block specs, none of which changes
 * the schema: collab builds it without them (breatic#1488 §11.1).
 */
export interface DocumentSchemaViews {
  /** Gives a media block its node view. */
  readonly media?: <T extends MediaBlockSpec>(spec: T) => T;
  /** The table's frame and paste rule. */
  readonly table?: DocTableView;
}

/**
 * A media spec carrying its node, built now as web's media view builds it,
 * for a schema built with no views. A spec made by `createBlockSpec` has no
 * node until the schema is built, and the schema places a node it is handed
 * ahead of the ones it builds, so building it here keeps the node order the
 * browser's schema has.
 * @param spec - The spec.
 * @returns The same spec, carrying its node.
 */
function noView<T extends MediaBlockSpec>(spec: T): T {
  const built = addNodeAndExtensionsToSpec(
    spec.config as never,
    spec.implementation as never,
    spec.extensions as never,
  ) as unknown as { implementation: { node: unknown } };
  return { ...spec, implementation: { ...spec.implementation, node: built.implementation.node } };
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

/**
 * The pixel size of the picture or the video, as the server read it off the
 * stored file (inner#1127 A23, inner#1367): the block keeps the media's place
 * at its final size while it loads.
 */
const MEDIA_SIZE_PROPS: Record<string, PropDecl> = {
  mediaWidth: { default: undefined, type: 'number' },
  mediaHeight: { default: undefined, type: 'number' },
};

/**
 * The id of the upload a media block waits for (inner#1351 design §5.5): set
 * while the block is pending (its `url` empty), cleared when the address is
 * written.
 */
const UPLOAD_ID_PROP: Record<string, PropDecl> = {
  uploadId: { default: '' },
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
 * Builds the schema: twelve block types, five added props, the rest turned off.
 * @param views - What the browser's editor adds; nothing by default.
 * @returns The schema to hand `BlockNoteEditor.create`.
 * @throws {Error} Whatever BlockNote throws while validating the specs.
 */
export function buildDocumentSchema(views: DocumentSchemaViews = {}): ReturnType<typeof BlockNoteSchema.create> {
  const withMediaView = views.media ?? noView;
  const {
    // Turned off this version — they reach the fallback path instead of the
    // menu, which could not name them. `quote` goes with them because
    // `quoted` is the model now, and two representations of one thing would
    // make the coexistence rule false for whichever came in as a container.
    quote: _quote,
    toggleListItem: _toggleListItem,
    // Uploads admit images, videos and audio only (inner#1127 A5), so nothing
    // this Space does can produce a generic file block.
    file: _file,
    ...enabled
  } = defaultBlockSpecs;

  const lists = buildListItemSpecs();
  const blockSpecs = {
    paragraph: withProps(enabled.paragraph, QUOTED_PROP),
    // Three levels, not the six BlockNote ships: `h3` is already 17px against
    // a 15px paragraph and a fourth has nowhere to sit. `levels` is the one
    // place that says so — it feeds the `level` prop's permitted values, the
    // markdown input rules and the `Mod-Alt-N` shortcuts alike, so a level
    // left out cannot be reached by typing `#### `, by a shortcut, or by a
    // block written straight into the document.
    heading: withProps(createHeadingBlockSpec({ levels: BODY_HEADING_LEVELS }), {
      ...QUOTED_PROP,
      ...NUMBERED_PROPS,
    }),
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
    // The library's own `---` rule is dropped: its wrapper always ends by
    // putting the caret at the start of the new block, which for a block with
    // no text is a node selection the user cannot type into
    // (`ExtensionManager/index.ts:565-583`). `documentDividerInputExtension`
    // places the divider and the caret in one transaction instead.
    divider: { ...withProps(enabled.divider, QUOTED_PROP), extensions: [] },
    // Stored tables from before cells held blocks, kept as stored
    // (inner#1619).
    table: legacyTableSpec(),
    ...docTableSpecs(views.table),
    // The library's own props: image and video carry a width and an
    // alignment, audio neither (inner#1127 A8, A9).
    image: withMediaView(
      withProps(enabled.image, { ...QUOTED_PROP, ...MEDIA_SIZE_PROPS, ...UPLOAD_ID_PROP }),
    ),
    video: withMediaView(
      withProps(enabled.video, { ...QUOTED_PROP, ...MEDIA_SIZE_PROPS, ...UPLOAD_ID_PROP }),
    ),
    audio: withMediaView(withProps(enabled.audio, { ...QUOTED_PROP, ...UPLOAD_ID_PROP })),
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
