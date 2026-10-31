// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

import { db, initCore } from "@breatic/core";
import { duplicateProject, getProjectById } from "@server/modules/project/project.repo.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore({ DATABASE_URL: inject("DATABASE_URL"), YJS_DATABASE_URL: inject("YJS_DATABASE_URL") });
  sql = postgres(inject("DATABASE_URL"), { max: 1, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

describe("duplicateProject initial Space type", () => {
  it.each(["3d", "document", "timeline", "canvas"] as const)(
    "preserves %s before the source Project has ever opened or seeded a Y.Doc",
    async (kind) => {
      const suffix = randomUUID();
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO users (email, email_verified)
        VALUES (${`duplicate-${suffix}@example.test`}, true) RETURNING id
      `;
      const userId = user!.id;
      const [studio] = await sql<{ id: string }[]>`
        INSERT INTO studios (created_by_user_id, slug, type, name)
        VALUES (${userId}, ${`s-${suffix}`}, 'team', 'Studio') RETURNING id
      `;
      const [sourceRow] = await sql<{ id: string }[]>`
        INSERT INTO projects (studio_id, created_by_user_id, name, slug, initial_space_type)
        VALUES (${studio!.id}, ${userId}, 'Unopened', ${`source-${suffix}`}, ${kind}) RETURNING id
      `;
      // No collab connection or content/meta seed is created for this source.
      const source = await getProjectById(sourceRow!.id);
      if (!source) throw new Error("Source Project fixture was not persisted");

      const copy = await db.transaction(async (tx) => duplicateProject(tx, userId, source, "Copy"));

      const [stored] = await sql<{ initial_space_type: string }[]>`
        SELECT initial_space_type FROM projects WHERE id = ${copy.id}
      `;
      expect(stored!.initial_space_type).toBe(kind);
      const owners = await sql<{ user_id: string; role: string }[]>`
        SELECT user_id, role FROM project_members WHERE project_id = ${copy.id}
      `;
      expect(owners).toEqual([{ user_id: userId, role: "owner" }]);
      const commands = await sql<{ kind: string; payload: { sourceId: string; newId: string } }[]>`
        SELECT kind, payload FROM project_lifecycle_outbox WHERE payload->>'newId' = ${copy.id}
      `;
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        kind: "project:duplicated",
        payload: { sourceId: source.id, newId: copy.id },
      });
    },
  );
});
