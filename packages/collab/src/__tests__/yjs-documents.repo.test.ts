/**
 * Unit tests for the collab `yjs_documents` repo (one table, one repo home).
 *
 * Pins the SQL-contract invariants the persistence / space-RPC / auth
 * callers depend on:
 *   - fetch SKIPS soft-deleted rows (a stale client must not recover a
 *     deleted doc) and returns null when no live row exists
 *   - store upserts and CLEARS deleted_at (resurrect-on-store semantics)
 *   - soft-delete only marks LIVE rows; restore clears deleted_at
 *
 * The `sql` tagged template is faked: it records the flattened query text
 * + interpolated values and returns a staged result, mirroring the auth
 * hook's `sqlQueue` test style (the real query runs against Postgres,
 * exercised end-to-end by the live collab service).
 */

import { describe, it, expect } from "vitest";
import {
  fetchDocumentData,
  storeDocument,
  softDeleteDocument,
  restoreDocument,
} from "@collab/services/yjs-documents.repo.js";

type RepoSql = Parameters<typeof fetchDocumentData>[0];

interface Captured {
  text: string;
  values: unknown[];
}

/** A fake tagged-template sql client recording each call + staged result. */
function fakeSql(results: unknown[][]): { sql: RepoSql; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const sql = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    calls.push({
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    });
    return Promise.resolve(results[i++] ?? []);
  };
  return { sql: sql as unknown as RepoSql, calls };
}

describe("yjs-documents.repo — fetchDocumentData", () => {
  it("returns the row's data blob filtered to live rows", async () => {
    const blob = new Uint8Array([1, 2, 3]);
    const { sql, calls } = fakeSql([[{ data: blob }]]);
    const out = await fetchDocumentData(sql, "project-p1/meta");
    expect(out).toBe(blob);
    // invariant: the read must skip soft-deleted rows.
    expect(calls[0]?.text).toContain("deleted_at IS NULL");
    expect(calls[0]?.values).toEqual(["project-p1/meta"]);
  });

  it("returns null when no live row exists", async () => {
    const { sql } = fakeSql([[]]);
    expect(await fetchDocumentData(sql, "missing")).toBeNull();
  });
});

describe("yjs-documents.repo — storeDocument", () => {
  it("upserts and clears deleted_at (resurrect on store)", async () => {
    const { sql, calls } = fakeSql([[]]);
    const state = new Uint8Array([9]);
    await storeDocument(sql, "doc", state);
    expect(calls[0]?.text).toContain("ON CONFLICT");
    expect(calls[0]?.text).toContain("deleted_at = NULL");
    expect(calls[0]?.values).toEqual(["doc", state]);
  });
});

describe("yjs-documents.repo — softDelete / restore", () => {
  it("soft-delete marks only live rows", async () => {
    const { sql, calls } = fakeSql([[]]);
    await softDeleteDocument(sql, "doc");
    expect(calls[0]?.text).toContain("SET deleted_at = now()");
    expect(calls[0]?.text).toContain("deleted_at IS NULL");
    expect(calls[0]?.values).toEqual(["doc"]);
  });

  it("restore clears deleted_at unconditionally", async () => {
    const { sql, calls } = fakeSql([[]]);
    await restoreDocument(sql, "doc");
    expect(calls[0]?.text).toContain("SET deleted_at = NULL");
    expect(calls[0]?.values).toEqual(["doc"]);
  });
});
