// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The document body's ProseMirror schema, built without a DOM (breatic#1488
 * §11.1): collab runs external-agent document commands against the same
 * schema the browser's editor binds to, so the document format version check
 * (§11.2) compares like with like.
 *
 * It is built the way web's `buildDocumentEditor` builds it: the same block
 * schema, plus the two marks extensions bring in (the comment mark, then the
 * fallback mark, in the order web registers them, which is the order
 * ProseMirror ranks marks by). An editor that is never mounted is headless,
 * and render functions only run from node views and serialisers, so nothing
 * here touches a DOM.
 */

import { BlockNoteEditor, createExtension } from "@blocknote/core";
import type { Schema } from "@tiptap/pm/model";

import { documentCommentMarkExtension } from "@shared/document/model/document-comment-mark.js";
import { buildDocumentSchema } from "@shared/document/model/document-schema-blocknote.js";
import { UnsupportedMark } from "@shared/document/model/document-unsupported-blocknote.js";

/** The fallback mark alone; web's own extension adds the label decorations on top. */
const fallbackMarkExtension = createExtension(() => ({
  key: "documentFallbacks",
  tiptapExtensions: [UnsupportedMark],
}) as never);

let built: BlockNoteEditor<never, never, never> | undefined;

/**
 * A headless editor on the document body's schema, built once per process.
 * Converting between Markdown and blocks (`tryParseMarkdownToBlocks`,
 * `blocksToMarkdownLossy`) needs a DOM to be installed first; the schema
 * does not.
 * @returns The editor.
 * @throws {Error} Whatever BlockNote throws while validating the specs.
 */
export function documentBlockEditor(): BlockNoteEditor<never, never, never> {
  built ??= BlockNoteEditor.create({
    schema: buildDocumentSchema(),
    extensions: [documentCommentMarkExtension(), fallbackMarkExtension()],
  } as never) as BlockNoteEditor<never, never, never>;
  return built;
}

/**
 * The document body's ProseMirror schema, built once per process.
 * @returns The schema.
 * @throws {Error} Whatever BlockNote throws while validating the specs.
 */
export function documentPmSchema(): Schema {
  return documentBlockEditor().pmSchema;
}
