// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a document Space's editor is able to represent, as plain data, plus the
 * check for whether this build's copy still matches the server's.
 *
 * ## The data itself is not here — it is in `config/document-schema.yaml`
 *
 * This module holds the SHAPE and the comparison; the values live in that one
 * file, and both ends read it. collab loads it when it loads a project's meta
 * document and publishes it there; the browser gets it compiled in at build time
 * (`packages/web/vite.config.mts` reads the file and defines it). Neither side
 * hand-keeps a second copy, so there is nothing to drift.
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

import { z } from "zod";

/** The top-level key the server writes this under in a project's meta document. */
export const DOCUMENT_SCHEMA_META_KEY = "documentSchema";

/**
 * The shape `config/document-schema.yaml` is parsed against.
 *
 * No version field: it is {@link documentSchemaVersion} of these two lists.
 *
 * Attribute lists are sorted on the way in so two copies that agree compare
 * equal regardless of the order they happen to be written in — which is also
 * what lets the version ignore attribute order without sorting again.
 */
export const documentSchemaConfigSchema = z.object({
  /** Node type name to its attribute names. */
  nodes: z.record(z.string(), z.array(z.string())).transform(sortAttributeLists),
  /** Mark type name to its attribute names. */
  marks: z.record(z.string(), z.array(z.string())).transform(sortAttributeLists),
});

/** A document Space's editor vocabulary, as both ends hold it. */
export type DocumentSchema = z.infer<typeof documentSchemaConfigSchema>;

/**
 * Sort each attribute list so two copies compare equal regardless of order.
 * @param half - One half of a vocabulary, straight out of the config file.
 * @returns The same half with every attribute list sorted.
 */
function sortAttributeLists(
  half: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, attrs] of Object.entries(half)) out[name] = [...attrs].sort();
  return out;
}

/** FNV-1a, 64-bit. Offset basis and prime are the constants from the FNV spec. */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const SIXTY_FOUR_BITS = 0xffffffffffffffffn;

/**
 * The one string a vocabulary reduces to before it is hashed.
 *
 * JSON does the escaping, so a type named `a:b` cannot be confused with a pair
 * named `a` and `b`, and the two halves are separate arrays, so a node and a
 * mark sharing a name stay distinct. Type names are sorted here because object
 * key order is insertion order and the config file's is arbitrary; attribute
 * lists are already sorted by {@link documentSchemaConfigSchema}.
 * @param schema - The vocabulary to serialise.
 * @returns A string that is equal for exactly the vocabularies that agree.
 */
function canonicalForm(schema: DocumentSchema): string {
  const half = (types: Record<string, string[]>): [string, string[]][] =>
    Object.keys(types)
      .sort()
      .map((name) => [name, types[name] ?? []]);
  return JSON.stringify([half(schema.nodes), half(schema.marks)]);
}

/**
 * This vocabulary's version — the thing both ends compare.
 *
 * Derived rather than declared, so that changing the lists changes it without
 * anyone having to remember. Equality is all that is ever asked of it, so a
 * digest serves as well as a counter and cannot be left behind.
 * @param schema - A vocabulary, as parsed from the config file.
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
 * Read the version out of whatever sits under the key in a meta document.
 *
 * A number there is what the previous generation wrote, when the version was
 * hand-kept in the config file. It reads as nothing rather than as a version:
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
 * @param mine - This build's version, from the config compiled into it.
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
