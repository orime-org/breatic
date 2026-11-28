// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What collab may write in the product database (inner#2043): per table,
 * whether it may insert rows and which columns it may update. Migration
 * `0143_collab_writer_role.sql` grants exactly this to the role
 * `collab_writer`, an integration test holds the two equal, and collab checks
 * its own connection against it at startup (`checkWriteScope`). Changing the
 * list needs the maintainer's approval and a migration in the same change.
 */

/** The NOLOGIN role migration 0143 creates; collab's login holds it and nothing else. */
export const COLLAB_WRITER_ROLE = "collab_writer";

/** Per table: whether rows may be inserted, and the columns that may be updated. */
export type CollabWriteScope = Readonly<Record<string, { readonly insert: boolean; readonly update: readonly string[] }>>;

/** The tables and columns collab writes. */
export const COLLAB_WRITE_SCOPE: CollabWriteScope = {
  project_activities: { insert: true, update: ["restored"] },
  account_activity_events: { insert: true, update: [] },
  project_edits: { insert: true, update: ["last_edited_at"] },
  projects: { insert: false, update: ["duplicate_completed_at"] },
};
