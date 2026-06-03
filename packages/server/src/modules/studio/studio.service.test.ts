// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * studio.service unit tests — ensurePersonalStudio idempotence + name fallback.
 *
 * Mocks studio.repo so the test runs without Postgres. Real DB
 * integration (partial unique index, race recovery) is covered by
 * the migration verify step.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./studio.repo.js", () => ({
  getByOwnerUserId: vi.fn(),
  createPersonalStudio: vi.fn(),
}));

import * as studioRepo from "./studio.repo.js";
import { ensurePersonalStudio } from "./studio.service.js";

const STUDIO = {
  id: "studio-1",
  ownerUserId: "user-1",
  name: "alice's Studio",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensurePersonalStudio", () => {
  it("returns the existing studio when one is already present", async () => {
    vi.mocked(studioRepo.getByOwnerUserId).mockResolvedValueOnce(STUDIO);

    const result = await ensurePersonalStudio("user-1", "alice");

    expect(result).toBe(STUDIO);
    expect(studioRepo.createPersonalStudio).not.toHaveBeenCalled();
  });

  it("creates a new studio with the username-based name when missing", async () => {
    vi.mocked(studioRepo.getByOwnerUserId).mockResolvedValueOnce(null);
    vi.mocked(studioRepo.createPersonalStudio).mockResolvedValueOnce(STUDIO);

    const result = await ensurePersonalStudio("user-1", "alice");

    expect(result).toBe(STUDIO);
    expect(studioRepo.createPersonalStudio).toHaveBeenCalledWith(
      "user-1",
      "alice's Studio",
      undefined,
    );
  });

  it("falls back to 'Personal Studio' when username is null", async () => {
    vi.mocked(studioRepo.getByOwnerUserId).mockResolvedValueOnce(null);
    vi.mocked(studioRepo.createPersonalStudio).mockResolvedValueOnce(STUDIO);

    await ensurePersonalStudio("user-1", null);

    expect(studioRepo.createPersonalStudio).toHaveBeenCalledWith(
      "user-1",
      "Personal Studio",
      undefined,
    );
  });
});
