// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * This is the publishing half. The values are `DOCUMENT_SCHEMA` in
 * `@breatic/shared`, the same constant the browser imports and compares
 * against — one declaration, both ends, nothing to read and nothing to drift.
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
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_META_KEY,
  DOCUMENT_SCHEMA_VERSION,
  documentSchemaMatches,
} from "@breatic/shared";

/** Named transaction origin, so a debugger can see who wrote this. */
export const DOCUMENT_SCHEMA_PUBLISH_ORIGIN = "document-schema-publish";

/**
 * Write this build's vocabulary into the meta document, if it is not there yet.
 *
 * Idempotent by design: several collab instances load the same meta document
 * independently, and a write on every load would broadcast a change to every
 * connected client for nothing.
 *
 * "Already the same" is the version — the same comparison the browser uses to
 * decide whether to stop editing, one rule, shared — AND the publish time,
 * because a correction to the date has to reach clients too. Every value
 * written here is a constant, so a process that has already published writes
 * nothing on later loads.
 * @param metaDoc - The project's meta document, as handed over by the load hook.
 * @returns True when this call wrote, false when the published copy already matched.
 */
export function publishDocumentSchema(metaDoc: Y.Doc): boolean {
  const published = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
  const current = published.toJSON();
  if (
    documentSchemaMatches(DOCUMENT_SCHEMA_VERSION, current) &&
    current.publishedAt === DOCUMENT_SCHEMA.publishedAt
  ) {
    return false;
  }

  metaDoc.transact(() => {
    published.set("version", DOCUMENT_SCHEMA_VERSION);
    published.set("nodes", DOCUMENT_SCHEMA.nodes);
    published.set("marks", DOCUMENT_SCHEMA.marks);
    // The vocabulary's own release date, in UTC. Not `new Date()` — that would
    // be the moment this process first loaded THIS project's meta, which for a
    // project nobody has opened since the release is days late and reads on
    // screen as "the new version went out just now".
    published.set("publishedAt", DOCUMENT_SCHEMA.publishedAt);
  }, DOCUMENT_SCHEMA_PUBLISH_ORIGIN);

  return true;
}
