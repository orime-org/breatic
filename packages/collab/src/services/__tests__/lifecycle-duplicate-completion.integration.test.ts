// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A copied Project is completed once (inner#1706 design 5.3, acceptance 4).
 *
 * Until collab has copied the source's documents, the copy's Project row says it is still being copied and no page
 * opens it. After the copy collab records the completion on the row; a command delivered again after that copies
 * nothing, so it can never overwrite what the user has since done in the copy. A command that copied but did not get
 * to record the completion copies again with the same result and then records it. While the copy has no stored meta
 * document and its completion is not recorded, collab refuses to load that document, so nothing seeds a default Space
 * over the copy whatever client connects (inner#1557). Real business and Yjs databases.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import * as Y from "yjs";

import { initCore, writeSpaceEntry } from "@breatic/core";
import { adminSql as sql } from "@collab/__tests__/helpers/admin-sql.js";
import { projectMetaDocName, spaceContentDocName } from "@breatic/shared";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { handleLifecycleEvent } from "@collab/services/lifecycle-listener.js";
import { fetchDoc } from "@collab/services/persistence.js";

beforeAll(() => {
  initCore(process.env);
});

interface CopyFixture {
  sourceId: string;
  copyId: string;
  spaceId: string;
}

/**
 * A source Project and a copy of it as the server's duplicate request leaves them: the copy's row exists, names its
 * source and is not completed.
 * @param seedSource - Whether the source has been opened, so it has a meta document and one canvas Space.
 * @returns The two Projects and the source's Space.
 * @throws {Error} When a database write fails.
 */
async function seedCopy(seedSource = true): Promise<CopyFixture> {
  const tag = randomUUID().replaceAll("-", "").slice(0, 16);
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`dup-${tag}@example.test`}, true) RETURNING id`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`dup-s-${tag}`}, 'personal', 'Copies') RETURNING id`;
  const [source] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studio!.id}, ${user!.id}, ${`dup-src-${tag}`}, 'Source') RETURNING id`;
  const [copy] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name, duplicated_from_id)
    VALUES (${studio!.id}, ${user!.id}, ${`dup-copy-${tag}`}, 'Source copy', ${source!.id}) RETURNING id`;
  const spaceId = randomUUID();
  if (seedSource) {
    const meta = new Y.Doc();
    writeSpaceEntry(meta.getMap("spaces"), {
      spaceId, type: "canvas", name: "Storyboard", order: 0, createdAt: 1, createdBy: user!.id,
    });
    await yjsRepo.upsertDocData(projectMetaDocName(source!.id), Y.encodeStateAsUpdate(meta));
    meta.destroy();
    const content = new Y.Doc();
    content.getMap("nodes").set("n1", "from the source");
    await yjsRepo.upsertDocData(spaceContentDocName(source!.id, spaceId, "canvas"), Y.encodeStateAsUpdate(content));
    content.destroy();
  }
  return { sourceId: source!.id, copyId: copy!.id, spaceId };
}

/**
 * Deliver the copy's lifecycle command once, as the consumer does.
 * @param fixture - The copy.
 * @returns Nothing.
 * @throws {Error} When the copy or the completion write fails.
 */
async function deliver(fixture: CopyFixture): Promise<void> {
  await handleLifecycleEvent(
    { type: "project:duplicated", sourceId: fixture.sourceId, newId: fixture.copyId, ts: Date.now() },
    async () => {},
  );
}

/**
 * When the copy's row says it was completed.
 * @param projectId - The copy.
 * @returns The completion time as stored text, or null while it is being copied.
 * @throws {Error} When the read fails.
 */
async function completedAt(projectId: string): Promise<string | null> {
  const [row] = await sql<{ at: string | null }[]>`
    SELECT duplicate_completed_at::text AS at FROM projects WHERE id = ${projectId}`;
  return row!.at;
}

/**
 * The name the copy's meta document gives a Space.
 * @param projectId - The copy.
 * @param spaceId - The Space.
 * @returns Its name, or undefined when the meta document or the entry is missing.
 * @throws {Error} When the read fails.
 */
async function spaceName(projectId: string, spaceId: string): Promise<unknown> {
  const data = await yjsRepo.fetchDocData(projectMetaDocName(projectId));
  if (data === null) return undefined;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, data);
  const entry = doc.getMap("spaces").get(spaceId) as Y.Map<unknown> | undefined;
  const name = entry?.get("name");
  doc.destroy();
  return name;
}

/**
 * Rename a Space in the copy's stored meta document, as a user editing the completed copy would.
 * @param projectId - The copy.
 * @param spaceId - The Space.
 * @param name - The new name.
 * @returns Nothing.
 * @throws {Error} When the read or the write fails.
 */
async function renameInCopy(projectId: string, spaceId: string, name: string): Promise<void> {
  const data = await yjsRepo.fetchDocData(projectMetaDocName(projectId));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, data!);
  (doc.getMap("spaces").get(spaceId) as Y.Map<unknown>).set("name", name);
  await yjsRepo.upsertDocData(projectMetaDocName(projectId), Y.encodeStateAsUpdate(doc));
  doc.destroy();
}

describe("completing a copied Project", () => {
  it("copies the source's documents and records the copy as completed", async () => {
    const fixture = await seedCopy();
    expect(await completedAt(fixture.copyId)).toBeNull();

    await deliver(fixture);

    expect(await completedAt(fixture.copyId)).not.toBeNull();
    expect(await spaceName(fixture.copyId, fixture.spaceId)).toBe("Storyboard");
    const content = await yjsRepo.fetchDocData(spaceContentDocName(fixture.copyId, fixture.spaceId, "canvas"));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, content!);
    expect(doc.getMap("nodes").get("n1")).toBe("from the source");
    doc.destroy();
  });

  it("leaves the user's edits and the completion time alone however often the command is delivered again", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.string({ minLength: 1, maxLength: 20 }), async (again, name) => {
        const fixture = await seedCopy();
        await deliver(fixture);
        const first = await completedAt(fixture.copyId);
        await renameInCopy(fixture.copyId, fixture.spaceId, name);

        for (let i = 0; i < again; i += 1) await deliver(fixture);

        expect(await spaceName(fixture.copyId, fixture.spaceId)).toBe(name);
        expect(await completedAt(fixture.copyId)).toBe(first);
      }),
      { numRuns: 8 },
    );
  });

  it("completes a copy whose documents were copied before the completion could be recorded", async () => {
    const fixture = await seedCopy();
    // The state a crash between the copy and the completion write leaves behind.
    await yjsRepo.duplicateByProjectPrefix(fixture.sourceId, fixture.copyId);
    expect(await completedAt(fixture.copyId)).toBeNull();

    await deliver(fixture);

    expect(await completedAt(fixture.copyId)).not.toBeNull();
    expect(await spaceName(fixture.copyId, fixture.spaceId)).toBe("Storyboard");
    expect(await yjsRepo.fetchDocData(spaceContentDocName(fixture.copyId, fixture.spaceId, "canvas"))).not.toBeNull();
  });

  it("completes a copy of a source that was never opened, leaving the copy to seed its own first Space", async () => {
    const fixture = await seedCopy(false);

    await deliver(fixture);

    expect(await completedAt(fixture.copyId)).not.toBeNull();
    expect(await yjsRepo.fetchDocData(projectMetaDocName(fixture.copyId))).toBeNull();
  });

  it("refuses to load the meta document of a copy still being copied, and seeds nothing for it", async () => {
    const fixture = await seedCopy();

    await expect(fetchDoc({ documentName: projectMetaDocName(fixture.copyId) })).rejects.toThrow();

    expect(await yjsRepo.fetchDocData(projectMetaDocName(fixture.copyId))).toBeNull();
    const [rows] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM projects WHERE id = ${fixture.copyId} AND duplicate_completed_at IS NOT NULL`;
    expect(rows!.n).toBe(0);
  });

  it("loads the copy's meta document with the source's Spaces once the copy is completed", async () => {
    const fixture = await seedCopy();
    await expect(fetchDoc({ documentName: projectMetaDocName(fixture.copyId) })).rejects.toThrow();

    await deliver(fixture);

    const loaded = await fetchDoc({ documentName: projectMetaDocName(fixture.copyId) });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, loaded!);
    expect([...doc.getMap("spaces").keys()]).toEqual([fixture.spaceId]);
    doc.destroy();
  });

  it("seeds a default Space for a copy of a never-opened source once the copy is completed", async () => {
    const fixture = await seedCopy(false);
    await deliver(fixture);

    const loaded = await fetchDoc({ documentName: projectMetaDocName(fixture.copyId) });

    const doc = new Y.Doc();
    Y.applyUpdate(doc, loaded!);
    expect(doc.getMap("spaces").size).toBe(1);
    doc.destroy();
  });
});
