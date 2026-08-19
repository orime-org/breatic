// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How many messages arrive when a long conversation is opened.
 *
 * The figure was a literal in the repo -- `MAX_HISTORY = 50`, with nothing
 * written anywhere near it about why fifty. It becomes `message_page_size` in
 * `config/agent.yaml` at thirty, the same figure the conversation list
 * already uses: the two are the same kind of dial and whoever reads that file
 * should not have to hold two numbers.
 *
 * Neither the size nor the turn-alignment beside it had any cover. The
 * alignment is right today and is asserted here so it stays right: a page is
 * cut on a turn boundary, because half a turn read back is an answer with no
 * question or a question with no answer.
 *
 * Design: inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * 8.5. Acceptance A19.
 */
import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import postgres from "postgres";
import { initCore, getAgentConfig } from "@breatic/core";
import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "message-page-size-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Seed an owner with a studio and a project they can write to.
 * @returns The freshly created user and project ids.
 */
async function seedProject(): Promise<{ userId: string; projectId: string }> {
  const tag = `mps-${seq++}`;
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
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studio!.id}, ${user!.id}, 'admin')
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${user!.id}, 'owner', null)
  `;
  return { userId: user!.id, projectId: project!.id };
}

/**
 * The configured page size, refusing to proceed without one.
 *
 * Without this check a missing key reads as `undefined`, every seeding loop
 * writes nothing, and the assertions below pass over an empty conversation
 * while proving nothing at all.
 * @returns How many messages one page holds.
 */
function pageSize(): number {
  const size = getAgentConfig().message_page_size;
  expect(size, "config/agent.yaml has no message_page_size").toBeGreaterThan(0);
  return size;
}

/**
 * A conversation holding a given number of two-message turns.
 * @param turns - How many question-and-answer pairs to write.
 * @returns The conversation id.
 */
async function conversationOf(turns: number): Promise<string> {
  const { userId, projectId } = await seedProject();
  const conv = await conversationRepo.createConversation(userId);
  await conversationRepo.setProjectId(conv.id, projectId);
  for (let i = 0; i < turns; i += 1) {
    const turn = await messageRepo.addMessage(conv.id, {
      role: "user",
      parts: [{ type: "text", text: `问第 ${i} 次` }],
    });
    await messageRepo.addMessage(conv.id, {
      role: "assistant",
      parts: [{ type: "text", text: `答第 ${i} 次` }],
      turnIndex: turn,
    });
  }
  return conv.id;
}

describe("opening a conversation with more messages than one page holds", () => {
  it("hands back a page of the configured size, and says more follows", async () => {
    const size = pageSize();
    // Two messages per turn, so this is comfortably more than one page
    // whatever the configured size is.
    const conv = await conversationOf(size);

    const page = await messageRepo.getMessages(conv);

    expect(page.hasMore).toBe(true);
    expect(page.messages.length).toBeLessThanOrEqual(size);
    // Not merely "at most a page": a page that came back half full would
    // satisfy the line above while making the reader scroll for what was
    // already there.
    expect(page.messages.length).toBeGreaterThan(size - 2);
  });

  it("cuts on a turn boundary rather than through one", async () => {
    const size = pageSize();
    const conv = await conversationOf(size);

    const page = await messageRepo.getMessages(conv);
    const turns = page.messages.map((m) => m.turnIndex);

    // Every turn present is present whole. Half a turn read back is an
    // answer with no question above it.
    for (const turn of new Set(turns)) {
      expect(turns.filter((t) => t === turn)).toHaveLength(2);
    }
  });

  it("says nothing follows when the whole conversation fits", async () => {
    const conv = await conversationOf(2);

    const page = await messageRepo.getMessages(conv);

    expect(page.hasMore).toBe(false);
    expect(page.messages).toHaveLength(4);
  });
});
