// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Publishing this build's document-editor vocabulary into a project's meta doc.
 *
 * A document Space stores its content as a Yjs fragment whose element names ARE
 * the editor's node names, and that vocabulary is compiled into the browser
 * bundle. A tab left open across a release is running an older one, and an
 * older vocabulary cannot represent what a newer one writes — so it has to be
 * able to find out, before it offers to edit, whether it still matches what the
 * server publishes.
 *
 * This is the publishing half. The browser reads the same key and compares it
 * against its own compiled-in copy (`documentSchemaDiffers`).
 *
 * WHY THE SERVER WRITES IT: the meta document is read-only for every client
 * (`hooks/auth.ts` sets `connectionConfig.readOnly` for `kind === "meta"`), and
 * a client's write there does not fail loudly — it simply never lands. A client
 * publishing its own vocabulary would also be answering the very question being
 * asked, which is whether that client is current.
 *
 * WHEN: from `afterLoadDocument`, on the direct document reference the hook
 * hands over. The same shape `handling-sweeper` uses, and for the same reason —
 * `openDirectConnection` from a load hook re-enters the same document and
 * deadlocks.
 */

import type * as Y from "yjs";
import { DOCUMENT_SCHEMA, DOCUMENT_SCHEMA_META_KEY } from "@breatic/shared";

/** Named transaction origin, so a debugger can see who wrote this. */
export const DOCUMENT_SCHEMA_PUBLISH_ORIGIN = "document-schema-publish";

/**
 * Whether what is already published says the same thing as this build.
 *
 * Compares only the vocabulary, never `publishedAt` — that field records when
 * the vocabulary last CHANGED. Including it would make every comparison differ
 * and rewrite the timestamp on every load, turning "when the new version went
 * out" into "when this document was last opened", which is not a fact anyone
 * needs and not what the client tells the user.
 * @param existing - Whatever sits under the key right now.
 * @returns True when it already matches this build exactly.
 */
function alreadyMatches(existing: unknown): boolean {
  if (typeof existing !== "object" || existing === null) return false;
  const { nodes, marks } = existing as { nodes?: unknown; marks?: unknown };
  return (
    JSON.stringify(nodes) === JSON.stringify(DOCUMENT_SCHEMA.nodes) &&
    JSON.stringify(marks) === JSON.stringify(DOCUMENT_SCHEMA.marks)
  );
}

/**
 * Write this build's vocabulary into the meta document, if it is not there yet.
 *
 * Idempotent by design: several collab instances load the same meta document
 * independently, and a write on every load would broadcast a change to every
 * connected client for nothing.
 * @param metaDoc - The project's meta document, as handed over by the load hook.
 * @returns True when this call wrote, false when the published copy already matched.
 */
export function publishDocumentSchema(metaDoc: Y.Doc): boolean {
  const published = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
  if (alreadyMatches(published.toJSON())) return false;

  metaDoc.transact(() => {
    published.set("nodes", DOCUMENT_SCHEMA.nodes);
    published.set("marks", DOCUMENT_SCHEMA.marks);
    published.set("publishedAt", new Date().toISOString());
  }, DOCUMENT_SCHEMA_PUBLISH_ORIGIN);

  return true;
}
