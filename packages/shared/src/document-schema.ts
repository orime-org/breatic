// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a document Space's editor is able to represent, as plain data, plus the
 * check for whether this build's idea of it still matches the server's.
 *
 * ## Why both ends need it
 *
 * A document Space stores its content as a Yjs XML fragment whose element
 * names ARE the editor's node names — the storage format and the editor's
 * vocabulary are one and the same thing, and that vocabulary is compiled into
 * the browser bundle. A tab left open across a release is running yesterday's
 * vocabulary against today's content: it cannot represent what it has not
 * heard of, and y-tiptap's answer to something it cannot represent is to
 * delete it from the shared document.
 *
 * So a client has to be able to ask "is my vocabulary still the one the server
 * is publishing" before it offers to edit. The server answers by writing this
 * list into the project's meta document under {@link DOCUMENT_SCHEMA_META_KEY};
 * the client compares it against the copy compiled into its own bundle. Two
 * builds made at different moments hold different copies, and that difference
 * is precisely the signal.
 *
 * This lives in shared because it is the one package both the browser and
 * collab can import. A second hand-kept copy on either side would be the same
 * agreement written down twice, and the halves would drift in silence: the
 * check would keep passing while the vocabularies diverged.
 *
 * ## Why the list is the identity, rather than a version number beside it
 *
 * A hand-written version number is a second thing to remember. Whoever adds a
 * node type edits the extensions; nothing about that edit makes them open this
 * file, and if they do not, the number still matches, the check still passes,
 * and the protection is gone with no error to show for it. The list cannot
 * drift from itself: change the vocabulary and the comparison changes with it.
 *
 * The attribute names are in the list for the same reason. Adding an attribute
 * to a node that both sides already know (a heading gaining an alignment, say)
 * changes nothing about the names, and the fallback never fires for it —
 * ProseMirror drops an unknown attribute silently rather than raising. This
 * comparison is the only thing that catches that class at all.
 *
 * The list here is written by hand, because collab cannot build a ProseMirror
 * schema — it has no editor. A test in the web package builds the real schema
 * from the registered extensions and asserts this list matches it, so the two
 * cannot part ways without a red test.
 */

/** A vocabulary: every node and mark name, each with its attribute names sorted. */
export interface DocumentSchemaShape {
  /** Node type name → its attribute names, sorted. */
  nodes: Record<string, readonly string[]>;
  /** Mark type name → its attribute names, sorted. */
  marks: Record<string, readonly string[]>;
}

/** The top-level key the server writes this under in a project's meta document. */
export const DOCUMENT_SCHEMA_META_KEY = "documentSchema";

/**
 * What the server writes: the vocabulary, plus when it was written.
 *
 * `publishedAt` is not part of the comparison — it exists so the client can
 * tell the user when the version they are behind went out, rather than
 * presenting the interruption with no context at all.
 */
export interface PublishedDocumentSchema extends DocumentSchemaShape {
  /** ISO timestamp of the moment the server last wrote a changed vocabulary. */
  publishedAt: string;
}

/**
 * This build's vocabulary for a document Space.
 *
 * Kept in step with `web/spaces/document/document-extensions` by
 * `document-schema-matches-extensions.test.ts`, which builds the real schema
 * and compares. Adding an extension, or an attribute to one, turns that test
 * red until this list says the same thing.
 */
export const DOCUMENT_SCHEMA: DocumentSchemaShape = {
  nodes: {
    blockquote: [],
    bulletList: [],
    codeBlock: ["language"],
    doc: [],
    hardBreak: [],
    heading: ["level"],
    horizontalRule: [],
    listItem: [],
    orderedList: ["start", "type"],
    paragraph: [],
    text: [],
    title: [],
    unsupportedBlock: ["originalName"],
    unsupportedInline: ["originalName"],
  },
  marks: {
    bold: [],
    code: [],
    italic: [],
    link: ["class", "href", "rel", "target", "title"],
    strike: [],
    underline: [],
    unsupportedMark: ["originalName", "originalValue"],
  },
};

/**
 * Read one half of a vocabulary out of untrusted data.
 * @param value - The candidate, straight out of a Yjs map.
 * @returns The half with attribute names sorted, or null if it is not one.
 */
function readHalf(value: unknown): Record<string, string[]> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string[]> = {};
  for (const [name, attrs] of Object.entries(value)) {
    if (!Array.isArray(attrs)) return null;
    if (attrs.some((attr) => typeof attr !== "string")) return null;
    out[name] = [...(attrs as string[])].sort();
  }
  return out;
}

/**
 * Normalise a candidate vocabulary so two of them can be compared.
 * @param value - The candidate, straight out of a Yjs map.
 * @returns A comparable string, or null if the value is not a vocabulary.
 */
function normalise(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { nodes, marks } = value as { nodes?: unknown; marks?: unknown };
  const readNodes = readHalf(nodes);
  const readMarks = readHalf(marks);
  if (readNodes === null || readMarks === null) return null;
  if (Object.keys(readNodes).length === 0 && Object.keys(readMarks).length === 0) return null;
  // Sorted, so two vocabularies that agree compare equal regardless of the
  // order their keys happen to be in.
  return JSON.stringify([
    Object.keys(readNodes).sort().map((name) => [name, readNodes[name]]),
    Object.keys(readMarks).sort().map((name) => [name, readMarks[name]]),
  ]);
}

/**
 * Whether this build's vocabulary differs from the one the server published.
 *
 * Asks whether the two DIFFER, not which is newer. A rollback leaves the
 * server behind this build rather than ahead of it, and that direction is just
 * as much a reason to stop: content this build can produce is content the
 * rolled-back majority cannot read.
 *
 * Absent or malformed server data answers false. Not knowing what the server
 * publishes is not the same as knowing it differs, and a project whose meta
 * predates this key — or a shape we ourselves wrote wrong — is no reason to
 * take the editor away from someone.
 * @param mine - This build's vocabulary.
 * @param fromMeta - Whatever sits under the key in the project's meta document.
 * @returns True only when both are readable vocabularies and they differ.
 */
export function documentSchemaDiffers(
  mine: DocumentSchemaShape,
  fromMeta: unknown,
): boolean {
  const theirs = normalise(fromMeta);
  if (theirs === null) return false;
  const ours = normalise(mine);
  if (ours === null) return false;
  return ours !== theirs;
}
