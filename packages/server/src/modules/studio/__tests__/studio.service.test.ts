// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * studio.service unit tests — personal-studio creation + lookup.
 *
 * Mocks studioRepo + studioMembersRepo + the db transaction so the test
 * runs without Postgres. The atomicity guarantee (studio + admin row in
 * one tx) and the partial-unique-index conflict mapping are covered for
 * real against Postgres in the setup-studio integration suite; these unit
 * tests pin the service wiring (slug = name, type personal, admin insert,
 * conflict-to-typed-error).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const studioRepoMock = vi.hoisted(() => ({
  createPersonalStudio: vi.fn(),
  getBySlug: vi.fn(),
  listByUser: vi.fn(),
  countMembersByStudioIds: vi.fn(),
}));

// db.transaction(cb) runs the callback immediately with a stub tx handle.
// Whether this deployment sells anything decides whether the trial grant's
// figure is read at all, so the flag is a knob here rather than whatever the
// developer's own .env happens to say.
const { envRef, mockTrialGrantCredits, mockFindPersonalByCreator, mockListStudiosOfUser } = vi.hoisted(() => ({
  envRef: { PAYMENT_ENABLED: true, REGION: "us-west", GLOBAL_REGION: "us-west", REGION_API_URLS: { sg: "http://sg.invalid" } },
  mockTrialGrantCredits: vi.fn(() => 100),
  mockFindPersonalByCreator: vi.fn(),
  mockListStudiosOfUser: vi.fn(),
}));
vi.mock("@breatic/core", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    env: envRef,
    studioDirectoryRepo: { findPersonalByCreator: mockFindPersonalByCreator, listStudiosOfUser: mockListStudiosOfUser },
    db: {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ TX: true }),
      ),
    },
  };
});

// The price file is a deployment's own and git does not track it, so a test
// that opened the real one would pass or fail on whether the machine running
// it happens to sell anything.
vi.mock("@server/config/pricing.js", () => ({
  getTrialGrantCredits: mockTrialGrantCredits,
}));

// Explicit (no importOriginal) so loading @breatic/domain never pulls the
// real agent llm and the `ai` SDK behind it.
// `vi.hoisted` keeps the spy reference valid inside the hoisted factory.
const { mockInsertAdmin, mockLoadStudioRole, mockCreateStudio, regionClientRef } =
  vi.hoisted(() => ({
    mockInsertAdmin: vi.fn().mockResolvedValue(undefined),
    mockLoadStudioRole: vi.fn(),
    mockCreateStudio: vi.fn(),
    regionClientRef: () => ({}),
  }));
vi.mock("@breatic/domain", () => ({
  studioRepo: studioRepoMock,
  studioMembersRepo: { insertAdmin: mockInsertAdmin, getRole: vi.fn() },
  studioAuthService: { loadStudioRole: mockLoadStudioRole },
  studioCreationService: { createStudio: mockCreateStudio },
  regionClient: regionClientRef,
  isKnownRegion: (region: string) => region === "us-west" || region === "sg",
}));

vi.mock("@breatic/shared", async (importOriginal: () => Promise<Record<string, unknown>>) => ({
  ...(await importOriginal()),
  t: (k: string) => k,
}));

const studioRepo = studioRepoMock;
import {
  createPersonalStudio,
  getPersonalStudio,
  getStudioDetail,
  listUserStudios,
} from "../studio.service.js";
import type { Studio } from "@breatic/shared";

const STUDIO: Studio = {
  id: "studio-1",
  createdByUserId: "user-1",
  slug: "alice-handle",
  type: "personal",
  name: "alice-handle",
  avatarUrl: null,
  bio: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  envRef.PAYMENT_ENABLED = true;
  mockTrialGrantCredits.mockReturnValue(100);
});

describe("createPersonalStudio", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("creates a personal Studio named by its slug, in the global region, with the price file's trial credits", async () => {
    mockCreateStudio.mockResolvedValueOnce(STUDIO);

    const result = await createPersonalStudio("user-1", "alice-handle");

    expect(result).toBe(STUDIO);
    // How much comes from the price file, so it is read from there rather
    // than written here.
    expect(mockCreateStudio).toHaveBeenCalledWith(
      {
        studioId: expect.stringMatching(UUID),
        userId: "user-1",
        type: "personal",
        slug: "alice-handle",
        name: "alice-handle",
        region: "us-west",
      },
      { regionClient: regionClientRef, trialCredits: 100 },
    );
  });

  it("never opens the price file when this deployment sells nothing", async () => {
    // The file belongs to a deployment that charges. Reading it anyway would
    // fail every registration on a self-hosted install over a number that
    // grants nothing.
    envRef.PAYMENT_ENABLED = false;
    mockCreateStudio.mockResolvedValueOnce(STUDIO);

    await createPersonalStudio("user-1", "alice-handle");

    expect(mockTrialGrantCredits).not.toHaveBeenCalled();
    expect(mockCreateStudio.mock.calls[0]![1]).toMatchObject({ trialCredits: 0 });
  });

  it("creates under the page's id in the region the page named", async () => {
    mockCreateStudio.mockResolvedValueOnce(STUDIO);

    await createPersonalStudio("user-1", "alice-handle", { studioId: "11111111-1111-4111-8111-111111111111", region: "sg" });

    expect(mockCreateStudio.mock.calls[0]![0]).toMatchObject({
      studioId: "11111111-1111-4111-8111-111111111111",
      region: "sg",
    });
  });

  it("refuses a region this deployment has no address for", async () => {
    await expect(createPersonalStudio("user-1", "alice-handle", { region: "mars" })).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(mockCreateStudio).not.toHaveBeenCalled();
  });
});

describe("getPersonalStudio", () => {
  it("returns the user's personal studio from the directory when present", async () => {
    mockFindPersonalByCreator.mockResolvedValueOnce({
      studioId: "studio-1",
      name: "Alice",
      slug: "alice-handle",
      avatarUrl: null,
    });
    expect(await getPersonalStudio("user-1")).toEqual({
      id: "studio-1",
      name: "Alice",
      slug: "alice-handle",
      avatarUrl: null,
    });
    expect(mockFindPersonalByCreator).toHaveBeenCalledWith("user-1");
  });

  it("returns null when the user has not completed onboarding (no studio)", async () => {
    mockFindPersonalByCreator.mockResolvedValueOnce(null);
    expect(await getPersonalStudio("user-1")).toBeNull();
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
      avatarUrl: null,
      bio: null,
      memberCount: 3,
      myStudioRole: "admin",
      region: null,
    });
    expect(studioRepo.getBySlug).toHaveBeenCalledWith("alice-handle");
    // loadStudioRole(userId, studioId) — service flips to the repo's order.
    expect(mockLoadStudioRole).toHaveBeenCalledWith("user-1", "studio-1");
  });

  it("returns myStudioRole null for a non-member — the public shell (decision A: 200 + non-member, not 403)", async () => {
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

/**
 * A Studio the user belongs to, as the directory lists it.
 * @param studioId - The Studio.
 * @param type - Personal or team.
 * @param role - The user's role.
 * @param region - Where it lives.
 * @returns The directory row.
 */
function directoryStudio(
  studioId: string,
  type: "personal" | "team",
  role: string,
  region: string | null = null,
): Record<string, unknown> {
  return {
    studioId,
    slug: `${studioId}-slug`,
    name: studioId,
    type,
    avatarUrl: null,
    region,
    role,
    memberCount: type === "personal" ? 1 : 4,
    createdAt: new Date(),
  };
}

describe("listUserStudios", () => {
  it("maps the directory's Studios to summaries with memberCount, role, region and the local bio", async () => {
    mockListStudiosOfUser.mockResolvedValueOnce([directoryStudio("studio-1", "personal", "admin")]);
    vi.mocked(studioRepo.listByUser).mockResolvedValueOnce([{ ...STUDIO, bio: "Hello", myStudioRole: "admin" }]);

    const result = await listUserStudios("user-1");

    expect(result).toEqual([
      {
        id: "studio-1",
        slug: "studio-1-slug",
        name: "studio-1",
        type: "personal",
        avatarUrl: null,
        bio: "Hello",
        memberCount: 1,
        myStudioRole: "admin",
        region: null,
      },
    ]);
  });

  it("lists a Studio another region holds, with its region and no bio", async () => {
    mockListStudiosOfUser.mockResolvedValueOnce([directoryStudio("studio-far", "team", "guest", "sg")]);
    vi.mocked(studioRepo.listByUser).mockResolvedValueOnce([]);

    const [far] = await listUserStudios("user-1");

    expect(far).toMatchObject({ id: "studio-far", region: "sg", bio: null, myStudioRole: "guest" });
  });

  it("returns the personal studio first even when the directory lists a team studio earlier", async () => {
    mockListStudiosOfUser.mockResolvedValueOnce([
      directoryStudio("studio-team", "team", "guest"),
      directoryStudio("studio-1", "personal", "admin"),
    ]);
    vi.mocked(studioRepo.listByUser).mockResolvedValueOnce([]);

    const result = await listUserStudios("user-1");

    expect(result.map((s) => s.id)).toEqual(["studio-1", "studio-team"]);
  });

  it("returns [] when the user belongs to no studios", async () => {
    mockListStudiosOfUser.mockResolvedValueOnce([]);
    vi.mocked(studioRepo.listByUser).mockResolvedValueOnce([]);

    expect(await listUserStudios("user-1")).toEqual([]);
  });
});
