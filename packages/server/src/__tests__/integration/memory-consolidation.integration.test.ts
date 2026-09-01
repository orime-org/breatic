// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one consolidation leaves in the database (#148, N2 N6 N8).
 *
 * The watermark is a promise about the rows either side of it: everything
 * under it is in memory, everything over it is still in the history. Three
 * writes have to hold that promise together — the conversation summary, the
 * project summary, and the watermark itself — and the ways they can come
 * apart only exist against a real database.
 *
 * Two browser tabs on one conversation is not a contrived case: both send,
 * both measure over the budget, and the later turn's history is longer, so
 * its window can end further along. The narrower one must not overwrite
 * memory that already covers more.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import postgres from "postgres";
import { initCore } from "@breatic/core";
import { memoryService } from "@server/modules";
import * as memoryRepo from "@server/modules/memory/memory.repo.js";
import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 8,
    prepare: false,
    connection: { application_name: "memory-consolidation-test-driver" },
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
 * @returns The ids a consolidation is written against.
 */
async function seed(): Promise<Seeded> {
  const tag = `mc-${seq++}-${Date.now().toString(36)}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'personal', ${tag}) RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}, 'studio') RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${user!.id}, 'owner', null)
  `;
  const conv = await conversationRepo.createConversation(user!.id);
  await conversationRepo.setProjectId(conv.id, project!.id);
  return { userId: user!.id, projectId: project!.id, conversationId: conv.id };
}

/**
 * How far a conversation says it is folded.
 * @param conversationId - The conversation to read.
 * @returns Its watermark.
 */
async function watermarkOf(conversationId: string): Promise<number> {
  const rows = await sql<{ last_consolidated_turn: number }[]>`
    SELECT last_consolidated_turn FROM conversations WHERE id = ${conversationId}
  `;
  return rows[0]!.last_consolidated_turn;
}

describe("a consolidation that lands", () => {
  it("reaches the next turn's prompt through both layers", async () => {
    // N2: the summary is worth writing only if the turn after it reads it.
    const { userId, projectId, conversationId } = await seed();

    await memoryService.commitConsolidation({
      userId,
      conversationId,
      projectId,
      data: {
        conversationUpdate: "they settled on a noir look",
        projectUpdate: "the project is a noir short",
        historyEntry: "agreed the look",
      },
      newWatermark: 12,
    });

    const context = await memoryService.buildContext(userId, conversationId, projectId);

    expect(context.conversationMemory).toContain("noir look");
    expect(context.projectMemory).toContain("noir short");
    expect(await watermarkOf(conversationId)).toBe(12);

    // The last hop, and the one N2 is actually about: the factory folds these
    // two into the instructions a turn is sent with. Stopping at the context
    // object leaves that hop unguarded, and it is a hop this task edited.
    const { buildAgentConfig } = await import("@breatic/domain");
    const { instructions } = buildAgentConfig({
      basePrompt: "system",
      memoryContext: context,
      interactive: true,
    });
    expect(instructions).toContain("noir look");
    expect(instructions).toContain("noir short");
  });

  it("hands the injection only as much memory as the ceiling allows", async () => {
    // N9's other half. Conversation memory is the one segment a consolidation
    // rewrites whole every time it runs, so it is the one that grows itself;
    // the ceiling is what stops it settling into the fixed cost that folding
    // cannot reduce.
    const { userId, projectId, conversationId } = await seed();
    const { getAgentConfig } = await import("@breatic/core");
    const ceiling = getAgentConfig().memory_conversation_max_size;

    await memoryService.commitConsolidation({
      userId,
      conversationId,
      projectId,
      data: {
        conversationUpdate: "x".repeat(ceiling + 500),
        historyEntry: "wrote a long one",
      },
      newWatermark: 12,
    });

    const context = await memoryService.buildContext(userId, conversationId, projectId);

    expect(context.conversationMemory).toHaveLength(ceiling);
  });

  it("records what it folded, in the history it keeps of itself", async () => {
    const { userId, projectId, conversationId } = await seed();

    await memoryService.commitConsolidation({
      userId,
      conversationId,
      projectId,
      data: {
        conversationUpdate: "they settled on a noir look",
        projectUpdate: "the project is a noir short",
        historyEntry: "agreed the look",
      },
      newWatermark: 3,
    });

    const entries = await sql<{ entry: string }[]>`
      SELECT entry FROM memory_history_entries WHERE conversation_id = ${conversationId}
    `;
    expect(entries.map((e) => e.entry)).toEqual(["agreed the look"]);
  });
});

describe("a consolidation that cannot finish", () => {
  it("leaves no memory behind when one of its writes fails", async () => {
    // N6: the three writes are one transaction. Half of them landing is the
    // state the watermark is supposed to rule out — turns that are in neither
    // the history nor the memory.
    const { userId, conversationId } = await seed();
    const noSuchProject = "00000000-0000-4000-8000-000000000000";

    await expect(
      memoryService.commitConsolidation({
        userId,
        conversationId,
        // The project row does not exist, so the project-memory write breaks
        // its foreign key after the conversation memory has been written.
        projectId: noSuchProject,
        data: {
          conversationUpdate: "this must not survive",
          projectUpdate: "nor this",
          historyEntry: "nor this",
        },
        newWatermark: 9,
      }),
    ).rejects.toThrow();

    expect(await memoryRepo.getConversationMemory(conversationId)).toBe("");
    expect(await watermarkOf(conversationId)).toBe(0);
    const entries = await sql<{ entry: string }[]>`
      SELECT entry FROM memory_history_entries WHERE conversation_id = ${conversationId}
    `;
    expect(entries).toHaveLength(0);
  });

  it("moves the watermark past a window it had to discard", async () => {
    // N4's other half, in the database: nothing is written, and the window is
    // never read again. Left where it was, the next turn would send a
    // strictly larger version of an input that already failed.
    const { conversationId } = await seed();

    await memoryService.discardConsolidation(conversationId, 14);

    expect(await watermarkOf(conversationId)).toBe(14);
    expect(await memoryRepo.getConversationMemory(conversationId)).toBe("");
  });
});

describe("two tabs that folded the same conversation", () => {
  it("keeps the memory covering the further watermark, and refuses the narrower write", async () => {
    // N8. The tab whose turn came second holds one more turn of history, so
    // its window ends further along. Whichever order they commit in, what is
    // left has to cover everything under the watermark.
    const { userId, projectId, conversationId } = await seed();

    const further = await memoryService.commitConsolidation({
      userId,
      conversationId,
      projectId,
      data: {
        conversationUpdate: "everything through turn 12",
        projectUpdate: "the project, through turn 12",
        historyEntry: "folded to 12",
      },
      newWatermark: 12,
    });
    const narrower = await memoryService.commitConsolidation({
      userId,
      conversationId,
      projectId,
      data: {
        conversationUpdate: "everything through turn 10",
        projectUpdate: "the project, through turn 10",
        historyEntry: "folded to 10",
      },
      newWatermark: 10,
    });

    expect(further).toBe("written");
    expect(narrower).toBe("superseded");
    expect(await memoryRepo.getConversationMemory(conversationId)).toBe(
      "everything through turn 12",
    );
    expect(await memoryRepo.getProjectMemory(userId, projectId)).toBe(
      "the project, through turn 12",
    );
    expect(await watermarkOf(conversationId)).toBe(12);
  });

  it("writes nothing at all on the refused side", async () => {
    // Not even the audit trail: the refusal happens before any of the three
    // writes, so there is no half-written consolidation to reconcile later.
    const { userId, projectId, conversationId } = await seed();

    await memoryService.commitConsolidation({
      userId,
      conversationId,
      projectId,
      data: {
        conversationUpdate: "through 12",
        projectUpdate: "through 12",
        historyEntry: "folded to 12",
      },
      newWatermark: 12,
    });
    await memoryService.commitConsolidation({
      userId,
      conversationId,
      projectId,
      data: {
        conversationUpdate: "through 10",
        projectUpdate: "through 10",
        historyEntry: "folded to 10",
      },
      newWatermark: 10,
    });

    const entries = await sql<{ entry: string }[]>`
      SELECT entry FROM memory_history_entries WHERE conversation_id = ${conversationId}
    `;
    expect(entries.map((e) => e.entry)).toEqual(["folded to 12"]);
  });

  it("does not move a watermark backwards, even with nothing to write", async () => {
    const { conversationId } = await seed();

    await memoryService.discardConsolidation(conversationId, 12);
    await memoryService.discardConsolidation(conversationId, 10);

    expect(await watermarkOf(conversationId)).toBe(12);
  });
});
