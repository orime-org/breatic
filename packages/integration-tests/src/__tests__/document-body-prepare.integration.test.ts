// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import * as Y from "yjs";
import { DrizzleQueryError } from "drizzle-orm";
import { createTestDb, initCore } from "@breatic/core";
import {
  documentBodyFragment, documentBodyRecords, documentCommentThreads,
  DocumentBodyFormatError, encodeInitialSpaceContent,
} from "@breatic/shared";
import { createPersistenceExtension, fetchDoc } from "@collab/services/persistence.js";
import { seedInitialState } from "@collab/services/yjs-documents.repo.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import {
  openPreparationBytes, preparationTree, preparationXml, preparationXmlSnapshot,
  PREPARE_LIST_ID, PREPARE_PARAGRAPH_ID, PREPARE_THREAD,
} from "@integration-tests/__tests__/document-body-prepare-fixtures.js";

initCore(process.env);

const PREFIX = "project-16190000-1111-4111-8111-111111111111/";
const NAME = `${PREFIX}document-16190000-2222-4222-8222-222222222222`;
const COMMIT_GATE = 16190001;
let pg: ReturnType<typeof createTestDb>["client"];
const docs: Y.Doc[] = [];

interface StoredRow {
  data: Uint8Array;
  updated_at: string | null;
  deleted_at: string | null;
}

/**
 * Retains native documents until each test has finished its assertions.
 * @param doc - A test-owned document.
 * @returns The same document.
 * @throws {never}
 */
function keep(doc: Y.Doc): Y.Doc {
  docs.push(doc);
  return doc;
}

/**
 * Reads committed bytes and full-precision timestamps independently of the repo.
 * @returns The current fixture row, including its soft-delete state.
 * @throws {Error} If PG rejects the read or the fixture row disappeared.
 */
async function stored(): Promise<StoredRow> {
  const rows = await pg<StoredRow[]>`SELECT data, updated_at::text, deleted_at::text FROM yjs_documents WHERE name = ${NAME}`;
  const row = rows[0];
  if (row === undefined) throw new Error("Missing preparation fixture row");
  return row;
}

/**
 * Seeds only this suite's immutable document name through the actual repo.
 * @param doc - The original stored document.
 * @returns Its exact initial encoded bytes.
 * @throws {Error} If insertion fails or the row already exists.
 */
async function seed(doc: Y.Doc): Promise<Uint8Array> {
  const bytes = Y.encodeStateAsUpdate(doc);
  expect(await seedInitialState(NAME, bytes)).toBe(true);
  return bytes;
}

/**
 * Requires non-null prepared bytes while preserving the actual loading entry.
 * @returns The committed loading result.
 * @throws {Error} If the document is absent or preparation fails.
 */
async function load(): Promise<Uint8Array> {
  const bytes = await fetchDoc({ documentName: NAME });
  if (bytes === null) throw new Error("Expected a stored document");
  return bytes;
}

/**
 * Checks the independently specified content, IDs, formatting and threads.
 * @param doc - The actual loaded result.
 * @param text - Original paragraph content expected after preparation.
 * @throws {Error} If no complete production records frame exists.
 */
function assertPrepared(doc: Y.Doc, text = "A😀e\u0301B"): void {
  const view = preparationTree(doc);
  expect(view.owners.map((owner) => ({ id: owner.id, type: owner.type, text: owner.units.map((unit) => unit.value).join("") }))).toEqual([
    { id: PREPARE_PARAGRAPH_ID, type: "paragraph", text },
    { id: PREPARE_LIST_ID, type: "bulletListItem", text: "CD" },
  ]);
  expect(view.owners[0]!.attrs["textAlignment"]).toBe("center");
  expect([...view.body.facts.values()].filter((fact) => fact.kind === "mark").map((fact) => fact.payload).sort((a, b) => a.type.localeCompare(b.type))).toEqual([
    { type: "bold", attrs: {} },
    { type: "comment", attrs: { threadId: "prepare-thread", orphan: false } },
    { type: "link", attrs: { href: "https://example.com/original" } },
  ]);
  expect(documentCommentThreads(doc).toJSON()).toEqual({ "prepare-thread": PREPARE_THREAD });
}

/**
 * Installs a row-scoped real PostgreSQL fault or commit gate.
 * @param body - Trusted fixture-only PL/pgSQL statements.
 * @param deferred - Whether to execute at transaction commit.
 * @throws {Error} If PG rejects the fixture DDL.
 */
async function installTrigger(body: string, deferred: boolean): Promise<void> {
  await pg.unsafe(`CREATE FUNCTION test_body_prepare_1619() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN ${body} RETURN NEW; END; $body$`);
  const declaration = deferred ? "CONSTRAINT TRIGGER" : "TRIGGER";
  const timing = deferred ? "AFTER UPDATE" : "BEFORE UPDATE";
  const constraint = deferred ? "DEFERRABLE INITIALLY DEFERRED" : "";
  await pg.unsafe(`CREATE ${declaration} test_body_prepare_1619 ${timing} ON yjs_documents ${constraint} FOR EACH ROW WHEN (NEW.name = '${NAME}') EXECUTE FUNCTION test_body_prepare_1619()`);
}

/**
 * Removes only this suite's scoped trigger and function.
 * @throws {Error} If PG refuses fixture cleanup.
 */
async function removeTrigger(): Promise<void> {
  await pg.unsafe("DROP TRIGGER IF EXISTS test_body_prepare_1619 ON yjs_documents");
  await pg.unsafe("DROP FUNCTION IF EXISTS test_body_prepare_1619()");
}

beforeAll(() => {
  ({ client: pg } = createTestDb(inject("YJS_DATABASE_URL")));
});

beforeEach(async () => {
  await removeTrigger();
  await pg`DELETE FROM yjs_documents WHERE name LIKE ${`${PREFIX}%`}`;
});

afterEach(async () => {
  await removeTrigger();
  for (const doc of docs.splice(0)) doc.destroy();
});

afterAll(async () => {
  await pg`DELETE FROM yjs_documents WHERE name LIKE ${`${PREFIX}%`}`;
  await pg.end();
});

describe("document body preparation through real persistence and PostgreSQL", () => {
  it("returns records only after the same complete snapshot has committed", async () => {
    const source = keep(preparationXml());
    const originalXml = preparationXmlSnapshot(documentBodyFragment(source));
    await seed(source);
    const bytes = await load();
    const loaded = keep(openPreparationBytes(bytes));
    assertPrepared(loaded);
    expect(preparationXmlSnapshot(documentBodyFragment(loaded))).toEqual(originalXml);
    expect([...bytes]).toEqual([...(await stored()).data]);
  });

  it("leaves an already prepared row and every native identity byte-for-byte unchanged", async () => {
    const source = keep(openPreparationBytes(encodeInitialSpaceContent("document")));
    documentCommentThreads(source).set("prepare-thread", PREPARE_THREAD);
    const winner = await seed(source);
    const before = await stored();
    const identity = preparationTree(keep(openPreparationBytes(winner)));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await load();
      expect([...again]).toEqual([...winner]);
      expect(preparationTree(keep(openPreparationBytes(again)))).toEqual(identity);
      expect(await stored()).toEqual(before);
    }
  });

  it("re-reads the row after waiting for an earlier writer to commit", async () => {
    await seed(keep(preparationXml("AB")));
    const latest = Y.encodeStateAsUpdate(keep(preparationXml("ABZ")));
    const gate = await pg.reserve();
    const pending: Promise<unknown>[] = [];
    try {
      await gate`BEGIN`;
      await gate`SELECT name FROM yjs_documents WHERE name = ${NAME} AND deleted_at IS NULL FOR UPDATE`;
      await gate`UPDATE yjs_documents SET data = ${Buffer.from(latest)} WHERE name = ${NAME}`;
      const loading = load();
      pending.push(loading);
      await waitUntilBlockedOn(pg, ["yjs_documents", "for update"]);
      await gate`COMMIT`;
      const bytes = await loading;
      assertPrepared(keep(openPreparationBytes(bytes)), "ABZ");
      expect([...bytes]).toEqual([...(await stored()).data]);
    } finally {
      await gate`ROLLBACK`;
      gate.release();
      await Promise.allSettled(pending);
    }
  });

  it.each([2, 3])("serializes %i independent openers into one persisted winner", async (count) => {
    await seed(keep(preparationXml()));
    const gate = await pg.reserve();
    const pending: Promise<Uint8Array>[] = [];
    try {
      await gate`BEGIN`;
      await gate`SELECT name FROM yjs_documents WHERE name = ${NAME} AND deleted_at IS NULL FOR UPDATE`;
      pending.push(...Array.from({ length: count }, () => load()));
      await waitUntilBlockedOn(pg, ["yjs_documents", "for update"], count);
      await gate`COMMIT`;
      const winners = await Promise.all(pending);
      const committed = (await stored()).data;
      const expectedView = preparationTree(keep(openPreparationBytes(committed)));
      for (const winner of winners) {
        expect([...winner]).toEqual([...committed]);
        expect(preparationTree(keep(openPreparationBytes(winner)))).toEqual(expectedView);
        assertPrepared(keep(openPreparationBytes(winner)));
      }
    } finally {
      await gate`ROLLBACK`;
      gate.release();
      await Promise.allSettled(pending);
    }
  });

  it("treats a row deleted during the lock wait as absent without preparing it", async () => {
    const original = await seed(keep(preparationXml()));
    const gate = await pg.reserve();
    let loading: Promise<Uint8Array | null> | undefined;
    try {
      await gate`BEGIN`;
      await gate`SELECT name FROM yjs_documents WHERE name = ${NAME} AND deleted_at IS NULL FOR UPDATE`;
      await gate`UPDATE yjs_documents SET deleted_at = now() WHERE name = ${NAME}`;
      loading = fetchDoc({ documentName: NAME });
      await waitUntilBlockedOn(pg, ["yjs_documents", "for update"]);
      await gate`COMMIT`;
      expect(await loading).toBeNull();
      const row = await stored();
      expect([...row.data]).toEqual([...original]);
      expect(typeof row.deleted_at).toBe("string");
    } finally {
      await gate`ROLLBACK`;
      gate.release();
      if (loading !== undefined) await Promise.allSettled([loading]);
    }
  });

  it.each(["document", "canvas", "timeline"])("preserves the existing absent %s content result", async (kind) => {
    expect(await fetchDoc({ documentName: `${PREFIX}${kind}-33333333-3333-4333-8333-333333333333` })).toBeNull();
    const rows = await pg`SELECT name FROM yjs_documents WHERE name LIKE ${`${PREFIX}%`}`;
    expect(rows).toHaveLength(0);
  });

  it.each(["canvas", "timeline"])("does not interpret the existing %s payload as document records", async (kind) => {
    const name = `${PREFIX}${kind}-33333333-3333-4333-8333-333333333333`;
    const doc = keep(new Y.Doc());
    doc.getMap("content").set("value", kind);
    const original = Y.encodeStateAsUpdate(doc);
    await seedInitialState(name, original);
    expect([...(await fetchDoc({ documentName: name }))!]).toEqual([...original]);
  });

  it.each(["unknown-format", "unknown-version", "incomplete-meta", "broken-record", "broken-xml"])("rejects %s without changing the stored row or load target", async (kind) => {
    const source = keep(kind === "broken-record" ? openPreparationBytes(encodeInitialSpaceContent("document")) : preparationXml());
    const roots = documentBodyRecords(source);
    if (kind === "unknown-format") roots.metadata.set("format", "unknown.document.format");
    if (kind === "unknown-version") {
      roots.metadata.set("format", "breatic.document.records");
      roots.metadata.set("version", 99);
    }
    if (kind === "incomplete-meta") roots.metadata.set("format", "breatic.document.records");
    if (kind === "broken-record") roots.records.set("invalid", "{invalid-json");
    if (kind === "broken-xml") {
      documentBodyFragment(source).delete(0, documentBodyFragment(source).length);
      documentBodyFragment(source).insert(0, [new Y.XmlText("invalid root")]);
    }
    await seed(source);
    const before = await stored();
    const target = keep(new Y.Doc());
    let updates = 0;
    target.on("update", () => { updates += 1; });
    await expect(createPersistenceExtension().onLoadDocument({ documentName: NAME, document: target })).rejects.toBeInstanceOf(DocumentBodyFormatError);
    expect(updates).toBe(0);
    expect(documentBodyRecords(target).metadata.toJSON()).toEqual({});
    expect(await stored()).toEqual(before);
  });

  it("keeps the load target empty until the actual PostgreSQL commit succeeds", async () => {
    await seed(keep(preparationXml()));
    const before = await stored();
    await installTrigger(`PERFORM pg_advisory_xact_lock(${COMMIT_GATE});`, true);
    const gate = await pg.reserve();
    const target = keep(new Y.Doc());
    const pending: Promise<void>[] = [];
    try {
      await gate`SELECT pg_advisory_lock(${COMMIT_GATE})`;
      pending.push(createPersistenceExtension().onLoadDocument({ documentName: NAME, document: target }));
      await waitUntilBlockedOn(pg, ["commit"]);
      expect(documentBodyRecords(target).metadata.toJSON()).toEqual({});
      expect(await stored()).toEqual(before);
      await gate`SELECT pg_advisory_unlock(${COMMIT_GATE})`;
      await pending[0];
      assertPrepared(target);
      expect([...Y.encodeStateAsUpdate(target)]).toEqual([...(await stored()).data]);
    } finally {
      await gate`SELECT pg_advisory_unlock(${COMMIT_GATE})`;
      gate.release();
      await Promise.allSettled(pending);
    }
  });

  it.each([false, true])("rolls back a real PG failure (deferred=%s) and retries from the actual current row", async (deferred) => {
    await seed(keep(preparationXml("AB")));
    const before = await stored();
    await installTrigger("RAISE EXCEPTION 'body preparation fixture failure';", deferred);
    const target = keep(new Y.Doc());
    const loading = createPersistenceExtension().onLoadDocument({ documentName: NAME, document: target });
    if (deferred) {
      await expect(loading).rejects.toThrow("body preparation fixture failure");
      await expect(loading).rejects.toMatchObject({ name: "PostgresError", code: "P0001" });
    } else {
      await expect(loading).rejects.toBeInstanceOf(DrizzleQueryError);
      await expect(loading).rejects.toMatchObject({
        cause: { name: "PostgresError", code: "P0001", message: "body preparation fixture failure" },
      });
    }
    expect(documentBodyRecords(target).metadata.toJSON()).toEqual({});
    expect(await stored()).toEqual(before);
    await removeTrigger();
    const current = Y.encodeStateAsUpdate(keep(preparationXml("ABZ")));
    await pg`UPDATE yjs_documents SET data = ${Buffer.from(current)} WHERE name = ${NAME}`;
    const retry = await load();
    assertPrepared(keep(openPreparationBytes(retry)), "ABZ");
    expect([...retry]).toEqual([...(await stored()).data]);
  });
});
