// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import type { NotificationEntity } from "@breatic/shared";

const asked = vi.hoisted(() => ({ users: [] as string[][] }));

vi.mock("@breatic/domain", () => ({
  profilesService: {
    personalProfiles: vi.fn(async (ids: string[]) => {
      asked.users.push(ids);
      return new Map(ids.map((id) => [id, { id, name: `name-${id}` }]));
    }),
  },
  studioRepo: { getIdentitiesByStudioIds: vi.fn(async () => new Map()) },
}));
vi.mock("@server/modules/project/project.repo.js", () => ({ getIdentitiesByProjectIds: vi.fn(async () => new Map()) }));

import { withResolvedRefs } from "@server/modules/notification/notification-refs.js";

/**
 * A notification carrying a payload.
 * @param payload - Its payload.
 * @returns The entity.
 */
function notification(payload: Record<string, unknown>): NotificationEntity {
  const now = new Date();
  return { id: "n", userId: "u", type: "comment.mentioned", payload, projectId: null, readAt: null, expiresAt: null, deletedAt: null, createdAt: now, updatedAt: now };
}

describe("withResolvedRefs", () => {
  it("resolves the author a comment mention names", async () => {
    const view = await withResolvedRefs([notification({ authorId: "author-1", threadId: "t" })]);
    expect(asked.users.at(-1)).toEqual(["author-1"]);
    expect(view.resolved.users["author-1"]).toMatchObject({ id: "author-1" });
  });
});
