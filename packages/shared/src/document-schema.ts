// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a document Space's editor is able to represent, as plain data, plus the
 * check for whether this build's copy still matches the server's.
 *
 * ## The data itself is not here — it is in `config/document-schema.yaml`
 *
 * This module holds the SHAPE and the comparison; the values live in that one
 * file, and both ends read it. collab loads it at startup and publishes it into
 * each project's meta document; the browser gets it compiled in at build time
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
 * The lists travel with the version because the version alone says nothing
 * about what actually changed. Attribute names are in them for a reason of
 * their own: adding an attribute to a node both sides already know leaves no
 * trace in the content, since ProseMirror drops an unknown attribute silently
 * rather than raising.
 */

import { z } from "zod";

/** The top-level key the server writes this under in a project's meta document. */
export const DOCUMENT_SCHEMA_META_KEY = "documentSchema";

/**
 * The shape `config/document-schema.yaml` is parsed against.
 *
 * Attribute lists are sorted on the way in so two copies that agree compare
 * equal regardless of the order they happen to be written in.
 */
export const documentSchemaConfigSchema = z.object({
  /** Bumped by hand whenever the lists below change. The comparison reads only this. */
  version: z.number().int().positive(),
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

/**
 * Read the version out of whatever sits under the key in a meta document.
 * @param fromMeta - The published entry, or anything at all.
 * @returns The version, or null when there is not a usable one there.
 */
export function publishedSchemaVersion(fromMeta: unknown): number | null {
  if (typeof fromMeta !== "object" || fromMeta === null) return null;
  const { version } = fromMeta as { version?: unknown };
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) {
    return null;
  }
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
export function documentSchemaDiffers(mine: number, fromMeta: unknown): boolean {
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
export function documentSchemaMatches(mine: number, fromMeta: unknown): boolean {
  const theirs = publishedSchemaVersion(fromMeta);
  if (theirs === null) return false;
  return theirs === mine;
}
