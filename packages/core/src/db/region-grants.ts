// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The last step of a migrate outside the global region (inner#1955): the
 * services' role may use every table except the global ones, which exist
 * there empty. Granting on every table each time keeps tables added by later
 * migrations usable.
 */

import { rawPg, yjsRawPg } from "@core/db/client.js";
import { TABLE_PLACEMENT } from "@core/db/table-placement.js";

/**
 * Grant the services' role the region's tables and take the global ones back.
 * @param role - The role the services connect as.
 * @returns Once both databases are granted.
 * @throws {Error} When the role does not exist or a statement fails.
 */
export async function applyRegionGrants(role: string): Promise<void> {
  const globalTables = Object.entries(TABLE_PLACEMENT)
    .filter(([, placement]) => placement === "global")
    .map(([table]) => table);
  await rawPg.begin(async (tx) => {
    await tx`GRANT USAGE ON SCHEMA public TO ${tx(role)}`;
    await tx`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${tx(role)}`;
    await tx`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${tx(role)}`;
    for (const table of globalTables) await tx`REVOKE ALL ON TABLE ${tx(table)} FROM ${tx(role)}`;
  });
  await yjsRawPg.begin(async (tx) => {
    await tx`GRANT USAGE ON SCHEMA public TO ${tx(role)}`;
    await tx`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${tx(role)}`;
    await tx`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${tx(role)}`;
  });
}
