// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Publishing this build's document-editor vocabulary into a project's meta doc.
 *
 * A document Space stores its content as a Yjs fragment whose element names ARE
 * the editor's node names, and that vocabulary ships inside the browser bundle.
 * A tab left open across a release is running an older one, and an older
 * vocabulary cannot represent what a newer one writes — so it has to be able to
 * find out, before it offers to edit, whether it still matches what the server
 * publishes.
 *
 * This is the publishing half. The values come from
 * `config/document-schema.yaml`, read once at startup by `getDocumentSchema()`;
 * the browser has the same file compiled into its bundle and compares versions.
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
import {
  DOCUMENT_SCHEMA_META_KEY,
  documentSchemaMatches,
  documentSchemaVersion,
} from "@breatic/shared";
import { getDocumentSchema } from "@breatic/core";

/** Named transaction origin, so a debugger can see who wrote this. */
export const DOCUMENT_SCHEMA_PUBLISH_ORIGIN = "document-schema-publish";

/**
 * Write this build's vocabulary into the meta document, if it is not there yet.
 *
 * Idempotent by design: several collab instances load the same meta document
 * independently, and a write on every load would broadcast a change to every
 * connected client for nothing.
 *
 * "Already the same" is decided by `documentSchemaMatches` on the version, the
 * same comparison the browser uses to decide whether to stop editing — one
 * rule, shared. `publishedAt` is not part of it: it records when the vocabulary
 * last CHANGED, and comparing it would differ every time and rewrite the
 * timestamp on every load, turning "when the new version went out" into "when
 * this document was last opened".
 * @param metaDoc - The project's meta document, as handed over by the load hook.
 * @returns True when this call wrote, false when the published copy already matched.
 * @throws {Error} When `config/document-schema.yaml` is missing or invalid.
 */
export function publishDocumentSchema(metaDoc: Y.Doc): boolean {
  const mine = getDocumentSchema();
  const version = documentSchemaVersion(mine);
  const published = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
  if (documentSchemaMatches(version, published.toJSON())) return false;

  metaDoc.transact(() => {
    published.set("version", version);
    published.set("nodes", mine.nodes);
    published.set("marks", mine.marks);
    published.set("publishedAt", new Date().toISOString());
  }, DOCUMENT_SCHEMA_PUBLISH_ORIGIN);

  return true;
}
