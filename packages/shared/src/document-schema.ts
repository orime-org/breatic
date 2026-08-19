// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a document Space's editor is able to represent, as plain data, plus the
 * check for whether this build's copy still matches the server's.
 *
 * ## One constant, both ends import it
 *
 * The vocabulary lives here because both ends need it and one of them is a
 * browser. It was briefly a YAML file that collab read with `readFileSync` and
 * the browser got through a build-time `define`, which bought nothing — the
 * browser half was compiled in either way, so editing the file was still a
 * release, not an operational knob — and cost eight places that could break:
 * a loader in core, a read plus a define in `vite.config.mts`, the same define
 * mirrored in `vitest.config.ts`, a wrapper module in web, a `COPY` line in
 * `Dockerfile.web` (which was missing, so the frontend image could not build
 * at all), a `--include` on collab's watcher, and a row in the config docs.
 * One exported constant has none of that, and TypeScript checks it at compile
 * time instead of zod checking it at load time.
 *
 * ## Why both ends need it at all
 *
 * A document Space stores its content as a Yjs XML fragment whose element names
 * ARE the editor's node names — the storage format and the editor's vocabulary
 * are one and the same thing, and that vocabulary ships inside the browser
 * bundle. A tab left open across a release is running yesterday's vocabulary
 * against today's content: it cannot represent what it has not heard of, and
 * y-tiptap's answer to something it cannot represent is to delete it from the
 * shared document.
 *
 * So a client has to be able to ask "is my copy still the one the server is
 * publishing" before it offers to edit. The server answers by writing this
 * entry into the project's meta document under {@link DOCUMENT_SCHEMA_META_KEY};
 * the client compares versions.
 *
 * ## The comparison is on `version`, and it asks whether they DIFFER
 *
 * Not which is newer. Whatever the reason two sides disagree, the client that
 * disagrees must stop editing — showing the panel is always the safe side, and
 * a client that is somehow ahead of the server has no business writing content
 * the rest cannot read either.
 *
 * ## `version` is computed from the lists, never written by hand
 *
 * A hand-kept number has to be remembered alongside every list change, and the
 * one check that goes red when a list changes — the web-side test that builds
 * the real ProseMirror schema and compares it against this vocabulary — does
 * not look at the number at all. Update the lists, watch it go green, walk
 * away, and the drift guard is off for the two classes only it can catch.
 * Deriving the number removes the step that could be forgotten.
 *
 * The lists travel with the version into meta because the version alone says
 * nothing about WHAT changed; when two sides disagree they are what makes the
 * disagreement readable. Attribute names are in them for a reason of their own:
 * adding an attribute to a node both sides already know leaves no trace in the
 * content, since ProseMirror drops an unknown attribute silently rather than
 * raising — so nothing but the version can catch it.
 */

/** The top-level key the server writes this under in a project's meta document. */
export const DOCUMENT_SCHEMA_META_KEY = "documentSchema";

/** A document Space's editor vocabulary, as both ends hold it. */
export interface DocumentSchema {
  /**
   * When this vocabulary went out, as UTC. The panel says "the new version went
   * out {when}", and only a person knows when that was — it cannot be derived
   * from anything, which is why it is written by hand while the version beside
   * it is computed.
   *
   * UTC, in the `Z` form: one instant travels to every client and each renders
   * it in its own time zone.
   */
  publishedAt: string;
  /** Node type name to its attribute names. */
  nodes: Record<string, string[]>;
  /** Mark type name to its attribute names. */
  marks: Record<string, string[]>;
}

/**
 * This build's document Space vocabulary — the one both ends import.
 *
 * Keep it in step with `buildDocumentExtensions` in `packages/web`. That is not
 * left to memory: `document-schema-matches-extensions.test.ts` builds the real
 * ProseMirror schema from the registered extensions and fails when it disagrees
 * with these two lists, down to attribute names.
 *
 * Set {@link DocumentSchema.publishedAt} whenever either list changes. Nothing
 * checks it — nothing can, since no code knows when a release happened — but
 * getting it wrong only misdates a sentence on a panel, while the version
 * beside it, which decides who stops editing, is computed from the lists.
 */
export const DOCUMENT_SCHEMA: DocumentSchema = {
  publishedAt: "2026-08-18T00:00:00Z",

  // Attribute names are here because adding an attribute to a node both sides
  // already know (a heading gaining an alignment, say) leaves no trace in the
  // content at all — ProseMirror drops an unknown attribute silently rather
  // than raising, so the fallback never fires for it.
  nodes: {
    blockquote: [],
    bulletList: [],
    codeBlock: ["language"],
    doc: [],
    hardBreak: [],
    heading: ["level"],
    listItem: [],
    orderedList: ["start", "type"],
    paragraph: [],
    text: [],
    // The three stand-in types. They must exist in every version: content one
    // build cannot represent is wrapped in these rather than deleted, and a
    // client that meets an already-wrapped element has to recognise the
    // wrapper.
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

/** FNV-1a, 64-bit. Offset basis and prime are the constants from the FNV spec. */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const SIXTY_FOUR_BITS = 0xffffffffffffffffn;

/**
 * The one string a vocabulary reduces to before it is hashed.
 *
 * JSON does the escaping, so a type named `a:b` cannot be confused with a pair
 * named `a` and `b`, and the two halves are separate arrays, so a node and a
 * mark sharing a name stay distinct. Both type names and attribute names are
 * sorted here rather than assumed to arrive sorted, so the answer depends on
 * nothing but the vocabulary itself.
 *
 * `publishedAt` is deliberately not in here. The version decides who gets shut
 * out of editing, and correcting a date is not a reason to shut anyone out.
 * @param schema - The vocabulary to serialise.
 * @returns A string that is equal for exactly the vocabularies that agree.
 */
function canonicalForm(schema: DocumentSchema): string {
  return JSON.stringify([orderedPairs(schema.nodes), orderedPairs(schema.marks)]);
}

/**
 * One half of a vocabulary as name/attributes pairs in name order.
 * @param types - Type name to its attribute names.
 * @returns The same entries, sorted by type name.
 */
function orderedPairs(types: Record<string, string[]>): [string, string[]][] {
  return Object.keys(types)
    .sort()
    .map((name) => [name, [...(types[name] ?? [])].sort()]);
}

/**
 * This vocabulary's version — the thing both ends compare.
 *
 * Derived rather than declared, so that changing the lists changes it without
 * anyone having to remember. Equality is all that is ever asked of it, so a
 * digest serves as well as a counter and cannot be left behind.
 * @param schema - A vocabulary.
 * @returns Sixteen lowercase hex characters.
 */
export function documentSchemaVersion(schema: DocumentSchema): string {
  const bytes = new TextEncoder().encode(canonicalForm(schema));
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & SIXTY_FOUR_BITS;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * This build's version of that vocabulary — what gets compared against meta.
 *
 * Computed, never written by hand. A hand-kept number has to be remembered
 * alongside every list change, and the one check that goes red when a list
 * changes does not look at it: update the lists, watch that test go green, walk
 * away, and the guard is off for the two classes only it can catch (an
 * attribute added to a node or mark both sides already know leaves no trace in
 * the content, so the fallback check is blind to it).
 *
 * Declared here rather than beside {@link DOCUMENT_SCHEMA} because it runs at
 * module load and everything it reaches — the hash constants above — has to be
 * initialised by then. `const` does not hoist.
 */
export const DOCUMENT_SCHEMA_VERSION: string = documentSchemaVersion(DOCUMENT_SCHEMA);

/**
 * Read the version out of whatever sits under the key in a meta document.
 *
 * A number there is what an earlier shape of this wrote, when the version was
 * a counter kept by hand. It reads as nothing rather than as a version:
 * "unreadable" already means "do not intercept", and the next collab to load
 * this meta overwrites it with the computed one.
 * @param fromMeta - The published entry, or anything at all.
 * @returns The version, or null when there is not a usable one there.
 */
export function publishedSchemaVersion(fromMeta: unknown): string | null {
  if (typeof fromMeta !== "object" || fromMeta === null) return null;
  const { version } = fromMeta as { version?: unknown };
  if (typeof version !== "string" || version.length === 0) return null;
  return version;
}

/**
 * Whether this build's vocabulary differs from the one the server published.
 *
 * Absent or malformed server data answers false. Not knowing what the server
 * publishes is not the same as knowing it differs, and a project whose meta
 * predates this key — or a shape we ourselves wrote wrong — is no reason to
 * take the editor away from someone.
 * @param mine - This build's version, computed from `DOCUMENT_SCHEMA`.
 * @param fromMeta - Whatever sits under the key in the project's meta document.
 * @returns True only when the server published a usable version and it differs.
 */
export function documentSchemaDiffers(mine: string, fromMeta: unknown): boolean {
  const theirs = publishedSchemaVersion(fromMeta);
  if (theirs === null) return false;
  return theirs !== mine;
}

/**
 * Whether what the server published is already exactly this build's version.
 *
 * This is what the publishing side asks before writing: several collab
 * instances load the same meta document independently, and rewriting on every
 * load would broadcast a change to every connected client for nothing.
 *
 * Not the negation of {@link documentSchemaDiffers}. The two answer different
 * questions and unreadable server data answers no to BOTH: not knowing what is
 * published is neither grounds to take the editor away from someone, nor
 * grounds for the server to stay silent.
 * @param mine - This build's version.
 * @param fromMeta - Whatever sits under the key in the project's meta document.
 * @returns True only when the server published a usable version and it matches.
 */
export function documentSchemaMatches(mine: string, fromMeta: unknown): boolean {
  const theirs = publishedSchemaVersion(fromMeta);
  if (theirs === null) return false;
  return theirs === mine;
}
