/**
 * Unit tests for {@link pingDb} — the single SELECT-1 liveness helper
 * shared by every backend service's /healthz probe and the boot
 * connectivity checks.
 *
 * The function is exercised with a fake postgres.js client (a callable
 * tagged-template stub) so no real pool / connection is built — the
 * default `rawPg` argument is never resolved.
 */

import { describe, it, expect, vi } from "vitest";
import type { Sql } from "postgres";
import { pingDb } from "@core/db/client.js";

/**
 * Build a fake postgres.js client whose tagged-template call resolves
 * to the given rows.
 * @param rows - Rows the `SELECT 1 AS ok` template resolves to
 * @returns A stub typed as `Sql` for {@link pingDb}
 */
function fakeClient(rows: unknown): Sql {
  return vi.fn(() => Promise.resolve(rows)) as unknown as Sql;
}

describe("pingDb", () => {
  it("returns true when SELECT 1 yields { ok: 1 }", async () => {
    await expect(pingDb(fakeClient([{ ok: 1 }]))).resolves.toBe(true);
  });

  it("returns false when the row shape is wrong (ok !== 1)", async () => {
    await expect(pingDb(fakeClient([{ ok: 0 }]))).resolves.toBe(false);
  });

  it("returns false when the query returns no rows", async () => {
    await expect(pingDb(fakeClient([]))).resolves.toBe(false);
  });

  it("propagates the driver error when the connection is unreachable", async () => {
    const boom = vi.fn(() =>
      Promise.reject(new Error("Connection refused")),
    ) as unknown as Sql;
    await expect(pingDb(boom)).rejects.toThrow(/Connection refused/);
  });
});
