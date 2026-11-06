// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Agent's memory entries against a real database (#1363).
 *
 * What one turn sees: the index of the member's Project entries and this
 * conversation's entries, newest first, with the migrated blocks apart and in
 * full. What the memory tools write: one entry per fact, the member's own,
 * refused by kind when an id is not theirs here or was deleted. What a
 * consolidation writes: its operations, the progress note and the watermark,
 * in one transaction or not at all, and only from the watermark it read.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import fc from "fast-check";
import postgres from "postgres";
import { db, initCore } from "@breatic/core";
import { MemoryRefused, type MemoryScope } from "@breatic/domain";
import { memoryService } from "@server/modules";
import * as memoryRepo from "@server/modules/memory/memory.repo.js";
import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
import { agentMemoryFor } from "@server/agent/agent-memory.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "agent-memories-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A user with a project and a conversation of their own in it. */
interface Seeded {
  userId: string;
  projectId: string;
  conversationId: string;
}

/**
 * Seed an owner with a project and one conversation.
 * @returns The ids.
 */
async function seed(): Promise<Seeded> {
  const tag = `am-${seq++}-${Date.now().toString(36)}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'personal', ${tag}) RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${user!.id}, 'owner', null)
  `;
  const conversationId = await newConversation(user!.id, project!.id);
  return { userId: user!.id, projectId: project!.id, conversationId };
}

/**
 * Another conversation of the same member in the same Project.
 * @param userId - Whose.
 * @param projectId - Where.
 * @returns Its id.
 */
async function newConversation(userId: string, projectId: string): Promise<string> {
  const conv = await conversationRepo.createConversation(userId, "deepseek/deepseek-v4.1-flash-1017");
  await conversationRepo.setProjectId(conv.id, projectId);
  return conv.id;
}

/** What an entry is seeded with. */
interface EntrySeed {
  conversationId?: string | null;
  title: string;
  content?: string;
  origin?: "agent" | "consolidation" | "migration";
  updatedAt?: string;
  deleted?: boolean;
}

/**
 * Write an entry straight into the table, so a case controls its time.
 * @param owner - Whose and where.
 * @param entry - The entry.
 * @returns Its id.
 */
async function seedEntry(owner: Seeded, entry: EntrySeed): Promise<string> {
  const at = entry.updatedAt ?? new Date().toISOString();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO agent_memories (user_id, project_id, conversation_id, source_conversation_id, title, content, origin, updated_at, deleted_at)
    VALUES (${owner.userId}, ${owner.projectId}, ${entry.conversationId ?? null}, ${owner.conversationId},
            ${entry.title}, ${entry.content ?? `${entry.title} in full`}, ${entry.origin ?? "agent"}, ${at},
            ${entry.deleted === true ? at : null})
    RETURNING id
  `;
  return row!.id;
}

/**
 * How far a conversation says it is folded.
 * @param conversationId - The conversation.
 * @returns Its watermark.
 */
async function watermarkOf(conversationId: string): Promise<number> {
  const rows = await sql<{ last_consolidated_turn: number }[]>`
    SELECT last_consolidated_turn FROM conversations WHERE id = ${conversationId}
  `;
  return rows[0]!.last_consolidated_turn;
}

/**
 * Entries as a consolidation is shown them in full, read from the table now.
 * @param ids - The entries.
 * @returns Each one's id, scope, title and content.
 */
async function shownOf(...ids: string[]): Promise<Array<{ id: string; scope: MemoryScope; title: string; content: string }>> {
  return sql<{ id: string; scope: MemoryScope; title: string; content: string }[]>`
    SELECT id, title, content,
      CASE WHEN conversation_id IS NULL THEN 'project' ELSE 'conversation' END AS scope
    FROM agent_memories WHERE id IN ${sql(ids)}
  `;
}

/**
 * What a promise rejected with.
 * @param pending - The call.
 * @returns The error.
 * @throws {Error} When the call succeeded.
 */
async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  return await pending.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (e: unknown) => e,
  );
}

describe("the index one turn is given", () => {
  it("lists the member's Project entries and this conversation's, newest first", async () => {
    const owner = await seed();
    const other = await newConversation(owner.userId, owner.projectId);
    const older = await seedEntry(owner, { title: "Palette", updatedAt: "2026-11-01T00:00:00Z" });
    const mine = await seedEntry(owner, { conversationId: owner.conversationId, title: "This chat only", updatedAt: "2026-11-02T00:00:00Z" });
    const newer = await seedEntry(owner, { title: "Lead character", updatedAt: "2026-11-03T00:00:00Z" });
    await seedEntry(owner, { conversationId: other, title: "Another chat's" });
    await seedEntry(owner, { title: "Deleted one", deleted: true });

    const context = await memoryService.buildContext(owner.userId, owner.conversationId, owner.projectId);

    expect(context.entries).toEqual([
      { id: newer, title: "Lead character" },
      { id: mine, title: "This chat only" },
      { id: older, title: "Palette" },
    ]);
    expect(context.olderCount).toBe(0);
    expect(context.migrated).toEqual([]);
  });

  it("keeps another member's entries in the same Project out", async () => {
    const owner = await seed();
    const [guest] = await sql<{ id: string }[]>`
      INSERT INTO users (email, email_verified) VALUES (${`am-guest-${Date.now().toString(36)}@example.com`}, true) RETURNING id
    `;
    await sql`
      INSERT INTO agent_memories (user_id, project_id, title, content, origin)
      VALUES (${guest!.id}, ${owner.projectId}, 'Guest note', 'not yours', 'agent')
    `;

    const context = await memoryService.buildContext(owner.userId, owner.conversationId, owner.projectId);

    expect(context.entries).toEqual([]);
  });

  it("carries migrated blocks apart and in full", async () => {
    const owner = await seed();
    const block = await seedEntry(owner, { title: "Earlier project memory", content: "The project is a noir short.", origin: "migration" });

    const context = await memoryService.buildContext(owner.userId, owner.conversationId, owner.projectId);

    expect(context.migrated).toEqual([{ id: block, title: "Earlier project memory", content: "The project is a noir short." }]);
    expect(context.entries).toEqual([]);
  });

  it("stops at the bound and counts what it left out", async () => {
    const owner = await seed();
    for (const day of ["01", "02", "03", "04"]) {
      await seedEntry(owner, { title: `Day ${day}`, updatedAt: `2026-11-${day}T00:00:00Z` });
    }

    const index = await memoryRepo.listIndex(
      { userId: owner.userId, projectId: owner.projectId, conversationId: owner.conversationId },
      2,
    );

    expect(index.entries.map((e) => e.title)).toEqual(["Day 04", "Day 03"]);
    expect(index.olderCount).toBe(2);
  });

  it("carries the conversation's progress note", async () => {
    const owner = await seed();
    await sql`INSERT INTO conversation_memories (conversation_id, content) VALUES (${owner.conversationId}, 'Settled the look.')`;

    const context = await memoryService.buildContext(owner.userId, owner.conversationId, owner.projectId);

    expect(context.progress).toBe("Settled the look.");
  });
});

describe("the memory tools' writes and reads", () => {
  it("add an entry the member's next conversation in the Project sees", async () => {
    const owner = await seed();
    const memory = agentMemoryFor(owner);

    const saved = await memory.save({ scope: "project", title: "All videos 9:16", content: "Every clip at most 8 seconds." });
    const next = await newConversation(owner.userId, owner.projectId);
    const context = await memoryService.buildContext(owner.userId, next, owner.projectId);

    expect(saved).toMatchObject({
      scope: "project",
      title: "All videos 9:16",
      content: "Every clip at most 8 seconds.",
      origin: "agent",
      sourceConversationId: owner.conversationId,
    });
    expect(context.entries).toEqual([{ id: saved.id, title: "All videos 9:16" }]);
  });

  it("keep a conversation entry to its conversation", async () => {
    const owner = await seed();
    const saved = await agentMemoryFor(owner).save({ scope: "conversation", title: "Draft 2 is the one", content: "Use draft 2." });
    const next = await newConversation(owner.userId, owner.projectId);

    expect((await memoryService.buildContext(owner.userId, next, owner.projectId)).entries).toEqual([]);
    expect((await memoryService.buildContext(owner.userId, owner.conversationId, owner.projectId)).entries).toEqual([
      { id: saved.id, title: "Draft 2 is the one" },
    ]);
  });

  it("replace the entry named, in place", async () => {
    const owner = await seed();
    const id = await seedEntry(owner, { title: "Lead character", content: "Green coat.", updatedAt: "2026-11-01T00:00:00Z" });

    const saved = await agentMemoryFor(owner).save({ id, scope: "project", title: "Lead character", content: "Red coat." });
    const [read] = await agentMemoryFor(owner).read([id]);

    expect(saved.id).toBe(id);
    expect(read?.content).toBe("Red coat.");
    expect(new Date(read!.updatedAt).getTime()).toBeGreaterThan(new Date("2026-11-01T00:00:00Z").getTime());
  });

  it("refuse an id that is not the member's here, by kind", async () => {
    const owner = await seed();
    const stranger = await seed();
    const theirs = await seedEntry(stranger, { title: "Stranger's" });
    const deleted = await seedEntry(owner, { title: "Gone", deleted: true });

    const unknown = await rejectionOf(agentMemoryFor(owner).save({ id: theirs, scope: "project", title: "t", content: "c" }));
    const gone = await rejectionOf(agentMemoryFor(owner).remove(deleted));

    expect(unknown).toBeInstanceOf(MemoryRefused);
    expect(unknown).toMatchObject({ kind: "unknown_entry", id: theirs });
    expect(gone).toMatchObject({ kind: "deleted", id: deleted });
  });

  it("delete softly, so the row stays and the index no longer lists it", async () => {
    const owner = await seed();
    const id = await seedEntry(owner, { title: "Wrong fact" });

    const removed = await agentMemoryFor(owner).remove(id);
    const [row] = await sql<{ deleted_at: Date | null }[]>`SELECT deleted_at FROM agent_memories WHERE id = ${id}`;

    expect(removed).toMatchObject({ id, title: "Wrong fact" });
    expect(row!.deleted_at).not.toBeNull();
    expect((await memoryService.buildContext(owner.userId, owner.conversationId, owner.projectId)).entries).toEqual([]);
  });

  it("read the entries named in the order named, leaving out the ones that are not the member's", async () => {
    const owner = await seed();
    const stranger = await seed();
    const a = await seedEntry(owner, { title: "A" });
    const b = await seedEntry(owner, { title: "B" });
    const theirs = await seedEntry(stranger, { title: "Theirs" });

    const read = await agentMemoryFor(owner).read([b, theirs, a]);

    expect(read.map((e) => e.id)).toEqual([b, a]);
  });

  it("find entries by words as written, ignoring case, with % and _ taken literally", async () => {
    const owner = await seed();
    const hit = await seedEntry(owner, { title: "Budget", content: "Keep it under 50% of the spend" });
    await seedEntry(owner, { title: "Other", content: "Keep it under 50 of the spend" });
    const under = await seedEntry(owner, { title: "file_name rule", content: "names use snake case" });
    await seedEntry(owner, { title: "filename rule", content: "names use kebab case" });

    const percent = await agentMemoryFor(owner).search("50%");
    const underscore = await agentMemoryFor(owner).search("FILE_NAME");

    expect(percent.items.map((e) => e.id)).toEqual([hit]);
    expect(underscore.items.map((e) => e.id)).toEqual([under]);
  });

  it("page a search, and refuse a cursor from another query", async () => {
    const owner = await seed();
    const { getAgentConfig } = await import("@breatic/core");
    const pageSize = getAgentConfig().records_page_size;
    for (let i = 0; i < pageSize + 1; i += 1) await seedEntry(owner, { title: `Shot ${String(i)}` });

    const first = await agentMemoryFor(owner).search("shot");
    const second = await agentMemoryFor(owner).search("shot", first.nextCursor ?? undefined);
    const refused = await rejectionOf(agentMemoryFor(owner).search("lens", first.nextCursor ?? undefined));

    expect(first.items).toHaveLength(pageSize);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(refused).toMatchObject({ kind: "bad_cursor" });
  });

  it("refuse every call once the member has left the Project", async () => {
    const owner = await seed();
    await sql`UPDATE project_members SET deleted_at = now() WHERE project_id = ${owner.projectId} AND user_id = ${owner.userId}`;

    const refused = await rejectionOf(agentMemoryFor(owner).read([owner.conversationId]));

    expect(refused).toMatchObject({ kind: "not_member" });
  });
});

describe("what a consolidation writes", () => {
  it("applies its operations, writes the progress note and moves the watermark together", async () => {
    const owner = await seed();
    const keep = await seedEntry(owner, { title: "Palette", content: "Teal." });
    const drop = await seedEntry(owner, { title: "Wrong fact" });

    const outcome = await memoryService.commitConsolidation({
      ...owner,
      shown: await shownOf(keep, drop),
      watermarkBefore: 0,
      newWatermark: 6,
      progress: "Settled the look; next is the storyboard.",
      operations: [
        { op: "add", scope: "project", title: "Lead character: Lin Wu", content: "Tear mole under the left eye." },
        { op: "update", id: keep, title: "Palette", content: "Teal and orange." },
        { op: "delete", id: drop },
      ],
    });
    const context = await memoryService.buildContext(owner.userId, owner.conversationId, owner.projectId);
    const [added] = await sql<{ origin: string; source_conversation_id: string }[]>`
      SELECT origin, source_conversation_id FROM agent_memories WHERE user_id = ${owner.userId} AND title = 'Lead character: Lin Wu'
    `;

    expect(outcome).toBe("written");
    expect(await watermarkOf(owner.conversationId)).toBe(6);
    expect(context.progress).toBe("Settled the look; next is the storyboard.");
    expect(context.entries.map((e) => e.title).sort()).toEqual(["Lead character: Lin Wu", "Palette"]);
    expect((await agentMemoryFor(owner).read([keep]))[0]?.content).toBe("Teal and orange.");
    expect(added).toEqual({ origin: "consolidation", source_conversation_id: owner.conversationId });
  });

  it("leaves the member's Project entries from other conversations as they were", async () => {
    const owner = await seed();
    const other = await newConversation(owner.userId, owner.projectId);
    const fromOther = await seedEntry({ ...owner, conversationId: other }, { title: "From the other chat", content: "Kept." });

    await memoryService.commitConsolidation({
      ...owner,
      shown: [],
      watermarkBefore: 0,
      newWatermark: 4,
      progress: "p",
      operations: [{ op: "add", scope: "project", title: "New", content: "n" }],
    });

    expect((await agentMemoryFor(owner).read([fromOther]))[0]?.content).toBe("Kept.");
  });

  it("writes nothing when the watermark is no longer where it read it", async () => {
    const owner = await seed();
    await conversationRepo.advanceConsolidatedTurn(owner.conversationId, 0, 8);

    const outcome = await memoryService.commitConsolidation({
      ...owner,
      shown: [],
      watermarkBefore: 0,
      newWatermark: 4,
      progress: "narrower",
      operations: [{ op: "add", scope: "project", title: "Narrower fold", content: "n" }],
    });
    const context = await memoryService.buildContext(owner.userId, owner.conversationId, owner.projectId);

    expect(outcome).toBe("superseded");
    expect(await watermarkOf(owner.conversationId)).toBe(8);
    expect(context.entries).toEqual([]);
    expect(context.progress).toBe("");
  });

  it("writes nothing at all when one of its writes fails", async () => {
    const owner = await seed();
    const keep = await seedEntry(owner, { title: "Palette", content: "Teal." });

    const failed = await rejectionOf(
      memoryService.commitConsolidation({
        ...owner,
        shown: await shownOf(keep),
        watermarkBefore: 0,
        newWatermark: 4,
        progress: "p",
        operations: [
          { op: "update", id: keep, title: "Palette", content: "Teal and orange." },
          // Longer than the column holds, so the database refuses this row.
          { op: "add", scope: "project", title: "t".repeat(201), content: "c" },
        ],
      }),
    );

    expect(failed).toBeInstanceOf(Error);
    expect(await watermarkOf(owner.conversationId)).toBe(0);
    expect((await agentMemoryFor(owner).read([keep]))[0]?.content).toBe("Teal.");
    expect((await memoryService.buildContext(owner.userId, owner.conversationId, owner.projectId)).progress).toBe("");
  });

  const update = (id: string) => ({ op: "update" as const, id, title: "Palette", content: "Teal and orange." });
  const remove = (id: string) => ({ op: "delete" as const, id });
  it.each([
    ["update", "its content", update, "project", "Palette", "Blue."],
    ["delete", "its content", remove, "project", "Palette", "Blue."],
    ["update", "its title", update, "project", "Colours", "Teal."],
    ["delete", "its title", remove, "project", "Colours", "Teal."],
    ["update", "its scope", update, "conversation", "Palette", "Teal."],
    ["delete", "its scope", remove, "conversation", "Palette", "Teal."],
  ] as const)("writes nothing when an entry it would %s had %s changed in another conversation since it read it", async (_op, _what, operation, scope, title, content) => {
    const owner = await seed();
    const other = await newConversation(owner.userId, owner.projectId);
    const keep = await seedEntry(owner, { title: "Palette", content: "Teal." });
    const shown = await shownOf(keep);
    await agentMemoryFor({ ...owner, conversationId: other }).save({ id: keep, scope, title, content });

    const failed = await rejectionOf(
      memoryService.commitConsolidation({
        ...owner,
        shown,
        watermarkBefore: 0,
        newWatermark: 4,
        progress: "p",
        operations: [{ op: "add", scope: "project", title: "New", content: "n" }, operation(keep)],
      }),
    );
    const rows = await sql<{ id: string; title: string; content: string; conversation_id: string | null; deleted_at: Date | null }[]>`
      SELECT id, title, content, conversation_id, deleted_at FROM agent_memories WHERE user_id = ${owner.userId}
    `;

    expect(failed).toBeInstanceOf(Error);
    expect(await watermarkOf(owner.conversationId)).toBe(0);
    expect(rows).toEqual([{ id: keep, title, content, conversation_id: scope === "conversation" ? other : null, deleted_at: null }]);
    expect((await memoryService.buildContext(owner.userId, owner.conversationId, owner.projectId)).progress).toBe("");
  });

  it("changes and deletes entries kept to this conversation alone", async () => {
    const owner = await seed();
    const changed = await seedEntry(owner, { conversationId: owner.conversationId, title: "Draft", content: "Use draft 2." });
    const dropped = await seedEntry(owner, { conversationId: owner.conversationId, title: "Old draft", content: "Use draft 1." });

    const ended = await memoryService.commitConsolidation({
      ...owner,
      shown: await shownOf(changed, dropped),
      watermarkBefore: 0,
      newWatermark: 4,
      progress: "p",
      operations: [
        { op: "update", id: changed, title: "Draft", content: "Use draft 3." },
        { op: "delete", id: dropped },
      ],
    });

    expect(ended).toBe("written");
    expect(await watermarkOf(owner.conversationId)).toBe(4);
    expect((await agentMemoryFor(owner).read([changed]))[0]?.content).toBe("Use draft 3.");
    expect(await agentMemoryFor(owner).read([dropped])).toEqual([]);
  });

  it("writes nothing when an entry it would change was deleted in another conversation since it read it", async () => {
    const owner = await seed();
    const keep = await seedEntry(owner, { title: "Palette", content: "Teal." });
    const shown = await shownOf(keep);
    await sql`UPDATE agent_memories SET deleted_at = now() WHERE id = ${keep}`;

    const failed = await rejectionOf(
      memoryService.commitConsolidation({
        ...owner,
        shown,
        watermarkBefore: 0,
        newWatermark: 4,
        progress: "p",
        operations: [{ op: "update", id: keep, title: "Palette", content: "Teal and orange." }],
      }),
    );

    expect(failed).toBeInstanceOf(Error);
    expect(await watermarkOf(owner.conversationId)).toBe(0);
    expect(await agentMemoryFor(owner).read([keep])).toEqual([]);
  });

  it("shows the consolidation the migrated blocks first, then the newest in full up to the bound, the rest by title", async () => {
    const owner = await seed();
    const block = await seedEntry(owner, { title: "Earlier project memory", content: "x".repeat(50), origin: "migration", updatedAt: "2026-10-01T00:00:00Z" });
    const newest = await seedEntry(owner, { title: "Newest", content: "y".repeat(30), updatedAt: "2026-11-03T00:00:00Z" });
    const oldest = await seedEntry(owner, { title: "Oldest", content: "z".repeat(30), updatedAt: "2026-11-01T00:00:00Z" });

    const input = await memoryService.consolidationInput(owner, 100);

    expect(input.full.map((e) => e.id)).toEqual([block, newest]);
    expect(input.titlesOnly).toEqual([{ id: oldest, title: "Oldest", scope: "project" }]);
  });

  it("counts the bound on what it is shown in full by character, an emoji as one", async () => {
    const owner = await seed();
    const emoji = await seedEntry(owner, { title: "Mood", content: "😀😀😀😀" });

    const input = await memoryService.consolidationInput(owner, 4);

    expect(input.full.map((e) => e.id)).toEqual([emoji]);
  });

  it("moves the watermark only forward and only with the entries and progress it covers, over any run of commit endings", async () => {
    /**
     * What a conversation's memory holds now.
     * @param owner - Whose.
     * @returns The watermark, the progress note and every entry row.
     */
    async function stateOf(owner: Seeded): Promise<{ watermark: number; progress: string; rows: unknown[] }> {
      const rows = await sql`
        SELECT id, title, content, conversation_id, deleted_at IS NULL AS live
        FROM agent_memories WHERE user_id = ${owner.userId} ORDER BY id
      `;
      const { progress } = await memoryService.buildContext(owner.userId, owner.conversationId, owner.projectId);
      return { watermark: await watermarkOf(owner.conversationId), progress, rows: [...rows] };
    }

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("written" as const, "superseded" as const, "changed" as const), { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 8, maxLength: 8 }),
        async (endings, widths) => {
          const owner = await seed();
          const other = await newConversation(owner.userId, owner.projectId);
          await seedEntry(owner, { title: "Palette", content: "Teal." });

          for (const [i, ending] of endings.entries()) {
            const { full } = await memoryService.consolidationInput(owner, 100_000);
            const target = full[0]!;
            if (ending === "changed") {
              await agentMemoryFor({ ...owner, conversationId: other }).save({ id: target.id, scope: "project", title: target.title, content: `${target.content} Changed ${String(i)}.` });
            }
            const before = await stateOf(owner);
            const watermarkBefore = ending === "superseded" ? before.watermark + 1 : before.watermark;
            const newWatermark = watermarkBefore + widths[i]!;
            const progress = `through ${String(newWatermark)}`;
            const ended = await memoryService
              .commitConsolidation({
                ...owner,
                shown: full,
                watermarkBefore,
                newWatermark,
                progress,
                operations: [
                  { op: "add", scope: "project", title: `Fact ${String(i)}`, content: "f" },
                  { op: "update", id: target.id, title: target.title, content: `${target.content} Fold ${String(i)}.` },
                ],
              })
              .catch(() => "failed" as const);
            const after = await stateOf(owner);

            if (ending === "written") {
              expect(ended).toBe("written");
              expect(after.watermark).toBe(newWatermark);
              expect(after.watermark).toBeGreaterThan(before.watermark);
              expect(after.progress).toBe(progress);
              expect(after.rows).toHaveLength(before.rows.length + 1);
            } else {
              expect(ended).toBe(ending === "superseded" ? "superseded" : "failed");
              expect(after).toEqual(before);
            }
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("a conversation that is deleted", () => {
  it("takes its own entries with it and leaves the Project's", async () => {
    const owner = await seed();
    const own = await seedEntry(owner, { conversationId: owner.conversationId, title: "This chat only" });
    const shared = await seedEntry(owner, { title: "Project fact" });

    await db.transaction(async (tx) => conversationRepo.cascadeDeleteConversations(tx, [owner.conversationId]));
    const rows = await sql<{ id: string; deleted_at: Date | null }[]>`
      SELECT id, deleted_at FROM agent_memories WHERE id IN (${own}, ${shared})
    `;

    expect(rows.find((r) => r.id === own)?.deleted_at).not.toBeNull();
    expect(rows.find((r) => r.id === shared)?.deleted_at).toBeNull();
  });
});
