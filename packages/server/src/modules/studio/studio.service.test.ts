// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * studio.service unit tests — personal-studio creation + lookup.
 *
 * Mocks studio.repo + studioMembersRepo + the db transaction so the test
 * runs without Postgres. The atomicity guarantee (studio + admin row in
 * one tx) and the partial-unique-index conflict mapping are covered for
 * real against Postgres in the setup-studio integration suite; these unit
 * tests pin the service wiring (slug = name, type personal, admin insert,
 * conflict-to-typed-error).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./studio.repo.js", () => ({
  createPersonalStudio: vi.fn(),
  getPersonalByCreator: vi.fn(),
  getPersonalNamesByCreators: vi.fn(),
  getBySlug: vi.fn(),
  listByUser: vi.fn(),
  countMembersByStudioIds: vi.fn(),
}));

// db.transaction(cb) runs the callback immediately with a stub tx handle.
vi.mock("@breatic/core", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    db: {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ TX: true }),
      ),
    },
  };
});

// Explicit (no importOriginal) so loading @breatic/domain never pulls the
// real agent llm → `ai` SDK → otel ESM chain (crashes under vitest).
// `vi.hoisted` keeps the spy reference valid inside the hoisted factory.
const { mockInsertAdmin, mockLoadStudioRole } = vi.hoisted(() => ({
  mockInsertAdmin: vi.fn().mockResolvedValue(undefined),
  mockLoadStudioRole: vi.fn(),
}));
vi.mock("@breatic/domain", () => ({
  studioMembersRepo: { insertAdmin: mockInsertAdmin, getRole: vi.fn() },
  studioAuthService: { loadStudioRole: mockLoadStudioRole },
}));

vi.mock("@breatic/shared", async (importOriginal: () => Promise<Record<string, unknown>>) => ({
  ...(await importOriginal()),
  t: (k: string) => k,
}));

import * as studioRepo from "./studio.repo.js";
import {
  createPersonalStudio,
  getPersonalStudio,
  getPersonalStudioNamesByUserIds,
  getStudioDetail,
  listUserStudios,
} from "./studio.service.js";
import type { Studio } from "@breatic/shared";

const STUDIO: Studio = {
  id: "studio-1",
  createdByUserId: "user-1",
  slug: "alice-handle",
  type: "personal",
  name: "alice-handle",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const TEAM_STUDIO: Studio = {
  id: "studio-team",
  createdByUserId: "user-9",
  slug: "acme",
  type: "team",
  name: "Acme",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createPersonalStudio", () => {
  it("creates the studio with slug = name = the chosen slug, type personal, + admin row in one tx", async () => {
    vi.mocked(studioRepo.createPersonalStudio).mockResolvedValueOnce(STUDIO);

    const result = await createPersonalStudio("user-1", "alice-handle");

    expect(result).toBe(STUDIO);
    // slug AND name are both the chosen slug (display name initially = slug).
    expect(studioRepo.createPersonalStudio).toHaveBeenCalledWith(
      "user-1",
      "alice-handle",
      "alice-handle",
      { TX: true },
    );
    // Admin member row written in the SAME tx (atomic with the studio insert).
    expect(mockInsertAdmin).toHaveBeenCalledWith("studio-1", "user-1", { TX: true });
  });

  it("maps a unique-violation (SQLSTATE 23505) slug collision to ConflictError, not a raw 500", async () => {
    const dbErr = Object.assign(new Error("duplicate key"), { code: "23505" });
    vi.mocked(studioRepo.createPersonalStudio).mockRejectedValueOnce(dbErr);

    await expect(createPersonalStudio("user-1", "taken-slug")).rejects.toMatchObject({
      name: "ConflictError",
      statusCode: 409,
    });
  });

  it("rethrows a non-unique-violation DB error unchanged (no silent swallow)", async () => {
    const dbErr = Object.assign(new Error("connection reset"), { code: "08006" });
    vi.mocked(studioRepo.createPersonalStudio).mockRejectedValueOnce(dbErr);

    await expect(createPersonalStudio("user-1", "some-slug")).rejects.toBe(dbErr);
  });
});

describe("getPersonalStudio", () => {
  it("returns the user's personal studio when present", async () => {
    vi.mocked(studioRepo.getPersonalByCreator).mockResolvedValueOnce(STUDIO);
    expect(await getPersonalStudio("user-1")).toBe(STUDIO);
  });

  it("returns null when the user has not completed onboarding (no studio)", async () => {
    vi.mocked(studioRepo.getPersonalByCreator).mockResolvedValueOnce(null);
    expect(await getPersonalStudio("user-1")).toBeNull();
  });
});

describe("getPersonalStudioNamesByUserIds", () => {
  it("delegates to the repo's batch name lookup", async () => {
    const names = new Map([["user-1", "alice-handle"]]);
    vi.mocked(studioRepo.getPersonalNamesByCreators).mockResolvedValueOnce(names);

    const result = await getPersonalStudioNamesByUserIds(["user-1", "user-2"]);

    expect(result).toBe(names);
    expect(studioRepo.getPersonalNamesByCreators).toHaveBeenCalledWith([
      "user-1",
      "user-2",
    ]);
  });
});

describe("getStudioDetail", () => {
  it("assembles the detail with the viewer's role + memberCount", async () => {
    vi.mocked(studioRepo.getBySlug).mockResolvedValueOnce(STUDIO);
    vi.mocked(studioRepo.countMembersByStudioIds).mockResolvedValueOnce(
      new Map([["studio-1", 3]]),
    );
    mockLoadStudioRole.mockResolvedValueOnce("admin");

    const detail = await getStudioDetail("alice-handle", "user-1");

    expect(detail).toEqual({
      id: "studio-1",
      slug: "alice-handle",
      name: "alice-handle",
      type: "personal",
      memberCount: 3,
      myStudioRole: "admin",
    });
    expect(studioRepo.getBySlug).toHaveBeenCalledWith("alice-handle");
    // loadStudioRole(userId, studioId) — service flips to the repo's order.
    expect(mockLoadStudioRole).toHaveBeenCalledWith("user-1", "studio-1");
  });

  it("returns myStudioRole null for a non-member — the public shell (decision A: 200 + guest, not 403)", async () => {
    vi.mocked(studioRepo.getBySlug).mockResolvedValueOnce(STUDIO);
    vi.mocked(studioRepo.countMembersByStudioIds).mockResolvedValueOnce(
      new Map([["studio-1", 1]]),
    );
    mockLoadStudioRole.mockResolvedValueOnce(null);

    const detail = await getStudioDetail("alice-handle", "stranger");

    expect(detail.myStudioRole).toBeNull();
  });

  it("throws NotFoundError when no active studio has that slug", async () => {
    vi.mocked(studioRepo.getBySlug).mockResolvedValueOnce(null);

    await expect(getStudioDetail("ghost", "user-1")).rejects.toMatchObject({
      name: "NotFoundError",
      statusCode: 404,
    });
  });

  it("defaults memberCount to 0 when the count map has no entry", async () => {
    vi.mocked(studioRepo.getBySlug).mockResolvedValueOnce(STUDIO);
    vi.mocked(studioRepo.countMembersByStudioIds).mockResolvedValueOnce(new Map());
    mockLoadStudioRole.mockResolvedValueOnce("admin");

    const detail = await getStudioDetail("alice-handle", "user-1");

    expect(detail.memberCount).toBe(0);
  });
});

describe("listUserStudios", () => {
  it("maps the user's studios to summaries with memberCount", async () => {
    vi.mocked(studioRepo.listByUser).mockResolvedValueOnce([STUDIO]);
    vi.mocked(studioRepo.countMembersByStudioIds).mockResolvedValueOnce(
      new Map([["studio-1", 1]]),
    );

    const result = await listUserStudios("user-1");

    expect(result).toEqual([
      {
        id: "studio-1",
        slug: "alice-handle",
        name: "alice-handle",
        type: "personal",
        memberCount: 1,
      },
    ]);
  });

  it("returns the personal studio first even when the repo lists a team studio earlier", async () => {
    vi.mocked(studioRepo.listByUser).mockResolvedValueOnce([TEAM_STUDIO, STUDIO]);
    vi.mocked(studioRepo.countMembersByStudioIds).mockResolvedValueOnce(
      new Map([
        ["studio-team", 4],
        ["studio-1", 1],
      ]),
    );

    const result = await listUserStudios("user-1");

    expect(result.map((s) => s.id)).toEqual(["studio-1", "studio-team"]);
  });

  it("returns [] (no count query) when the user belongs to no studios", async () => {
    vi.mocked(studioRepo.listByUser).mockResolvedValueOnce([]);

    const result = await listUserStudios("user-1");

    expect(result).toEqual([]);
    expect(studioRepo.countMembersByStudioIds).not.toHaveBeenCalled();
  });
});
