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
const { mockInsertAdmin } = vi.hoisted(() => ({
  mockInsertAdmin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@breatic/domain", () => ({
  studioMembersRepo: { insertAdmin: mockInsertAdmin, getRole: vi.fn() },
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
