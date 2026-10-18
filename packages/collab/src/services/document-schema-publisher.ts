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
 * hands over, because `openDirectConnection` from a load hook re-enters the
 * same document and deadlocks.
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

/** How the publisher decides whether to write. */
export interface PublishOptions {
  /**
   * Write whenever the version differs, whatever the published release time:
   * a rollback turns this on (`document_schema.force_publish`), since the
   * build it rolls back to was released earlier than the one published.
   */
  readonly force: boolean;
}

/**
 * The time a published vocabulary was released, as a number to compare.
 * @param value - What meta holds under `publishedAt`.
 * @returns Milliseconds since the epoch, or null when unreadable.
 */
function releasedAt(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * Write this build's vocabulary into the meta document, where it should be.
 *
 * Idempotent by design: several collab instances load the same meta document
 * independently, and a write on every load would broadcast a change to every
 * connected client for nothing.
 *
 * "Already the same" is the version — the same comparison the browser uses to
 * decide whether to stop editing, one rule, shared — AND the publish time,
 * because a correction to the date has to reach clients too.
 *
 * A version released later than this build's is left as it is (inner#1619
 * design 5.6): during a rolling release an instance still on the old build
 * would otherwise write its version over the new one, and every page on the
 * new build would be stopped while tabs on the old one were let through.
 * Released at the same time it is written over, as before.
 * @param metaDoc - The project's meta document, as handed over by the load hook.
 * @param options - Whether to write over a later release.
 * @returns True when this call wrote, false when it left meta as it was.
 */
export function publishDocumentSchema(metaDoc: Y.Doc, options: PublishOptions = { force: false }): boolean {
  const published = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
  const current = published.toJSON();
  if (
    documentSchemaMatches(DOCUMENT_SCHEMA_VERSION, current) &&
    current.publishedAt === DOCUMENT_SCHEMA.publishedAt
  ) {
    return false;
  }
  const theirs = releasedAt(current.publishedAt);
  const mine = releasedAt(DOCUMENT_SCHEMA.publishedAt);
  if (!options.force && theirs !== null && mine !== null && theirs > mine) {
    return false;
  }

  metaDoc.transact(() => {
    published.set("version", DOCUMENT_SCHEMA_VERSION);
    published.set("nodes", DOCUMENT_SCHEMA.nodes);
    published.set("marks", DOCUMENT_SCHEMA.marks);
    published.set("content", DOCUMENT_SCHEMA.content);
    // The vocabulary's own release date, in UTC. Not `new Date()` — that would
    // be the moment this process first loaded THIS project's meta, which for a
    // project nobody has opened since the release is days late and reads on
    // screen as "the new version went out just now".
    published.set("publishedAt", DOCUMENT_SCHEMA.publishedAt);
  }, DOCUMENT_SCHEMA_PUBLISH_ORIGIN);

  return true;
}

/**
 * Publishes now, and again every time someone else writes the published
 * vocabulary while this meta document stays loaded.
 *
 * Hocuspocus unloads a document only once nobody is connected, so a meta an
 * old-build instance wrote over during a rolling release would otherwise keep
 * the old version for as long as anyone has the project open. Instances on
 * the same build never answer each other: equal versions and times are left
 * alone, and this instance's own writes are not answered.
 * @param metaDoc - The project's meta document.
 * @param options - Whether to write over a later release.
 * @param onWrite - Told each time this writes, for the hook to log.
 * @returns A function that stops watching.
 */
export function keepDocumentSchemaPublished(
  metaDoc: Y.Doc,
  options: PublishOptions,
  onWrite: () => void = () => undefined,
): () => void {
  if (publishDocumentSchema(metaDoc, options)) onWrite();
  const published = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
  /**
   * Publishes again after someone else's write.
   * @param _event - The change.
   * @param transaction - The transaction that made it.
   */
  const onChange = (_event: Y.YMapEvent<unknown>, transaction: Y.Transaction): void => {
    if (transaction.origin === DOCUMENT_SCHEMA_PUBLISH_ORIGIN) return;
    if (publishDocumentSchema(metaDoc, options)) onWrite();
  };
  published.observe(onChange);
  return () => {
    published.unobserve(onChange);
  };
}
