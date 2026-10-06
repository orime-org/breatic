// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Chat writes that check only who owns a conversation still respect an
 * archived project: renaming a conversation, deleting one and deleting one of
 * its attachments are refused while the project is archived, and work again
 * once it is restored. Reading is unaffected.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import postgres from "postgres";
import { ConflictError, initCore } from "@breatic/core";

initCore(process.env);

import * as conversationService from "@server/modules/conversation/conversation.service.js";
import * as attachmentService from "@server/modules/conversation/conversation-attachment.service.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "chat-archived-project-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

interface Scene {
  ownerId: string;
  projectId: string;
  conversationId: string;
  attachmentId: string;
}

/** A project owned by one user, with a conversation of theirs carrying one attachment. */
async function seedScene(): Promise<Scene> {
  const tag = `chat-arch-${seq++}`;
  const [owner] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${owner!.id}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${owner!.id}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${owner!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${owner!.id}, 'owner', null)
  `;
  const [conversation] = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id, project_id, title) VALUES (${owner!.id}, ${project!.id}, 'chat') RETURNING id
  `;
  const [attachment] = await sql<{ id: string }[]>`
    INSERT INTO conversation_attachments (conversation_id, user_id, url, name, mime_type, size, kind)
    VALUES (${conversation!.id}, ${owner!.id}, 'https://cdn.test/a.png', 'a.png', 'image/png', 10, 'image')
    RETURNING id
  `;
  return {
    ownerId: owner!.id,
    projectId: project!.id,
    conversationId: conversation!.id,
    attachmentId: attachment!.id,
  };
}

/** Archive a project directly. */
async function archive(projectId: string, byUserId: string): Promise<void> {
  await sql`UPDATE projects SET archived_at = now(), archived_by_user_id = ${byUserId} WHERE id = ${projectId}`;
}

describe("on an archived project", () => {
  it("refuses renaming a conversation", async () => {
    const s = await seedScene();
    await archive(s.projectId, s.ownerId);
    await expect(
      conversationService.rename(s.conversationId, s.ownerId, s.projectId, "new"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses deleting a conversation", async () => {
    const s = await seedScene();
    await archive(s.projectId, s.ownerId);
    await expect(conversationService.deleteConversation(s.conversationId, s.ownerId)).rejects.toBeInstanceOf(
      ConflictError,
    );
    const [row] = await sql<{ deleted_at: Date | null }[]>`SELECT deleted_at FROM conversations WHERE id = ${s.conversationId}`;
    expect(row!.deleted_at).toBeNull();
  });

  it("refuses deleting an attachment", async () => {
    const s = await seedScene();
    await archive(s.projectId, s.ownerId);
    await expect(attachmentService.softDelete(s.attachmentId, s.ownerId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("still lets the owner read the conversation", async () => {
    const s = await seedScene();
    await archive(s.projectId, s.ownerId);
    const { conversation } = await conversationService.getWithMessages(s.conversationId, s.ownerId);
    expect(conversation.id).toBe(s.conversationId);
  });
});

describe("on a live project", () => {
  it("renames, deletes an attachment and deletes the conversation as before", async () => {
    const s = await seedScene();
    await conversationService.rename(s.conversationId, s.ownerId, s.projectId, "new");
    await attachmentService.softDelete(s.attachmentId, s.ownerId);
    await conversationService.deleteConversation(s.conversationId, s.ownerId);
    const [row] = await sql<{ deleted_at: Date | null }[]>`SELECT deleted_at FROM conversations WHERE id = ${s.conversationId}`;
    expect(row!.deleted_at).toBeInstanceOf(Date);
  });
});
