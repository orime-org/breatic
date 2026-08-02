// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * studioAvatar.service unit tests — the write ORDER, which nothing else pins.
 *
 * The integration suite drives this service over real HTTP against real
 * Postgres, and every one of its paths has both writes succeed. Order is
 * invisible when nothing fails, so swapping the two statements leaves that
 * whole suite green — measured, by inverting them and watching 14 tests pass.
 * The only way to see the order is to fail the storage write, which means
 * controlling the adapter, which means a unit test.
 *
 * `sniffMimeType` is deliberately NOT mocked: it is a pure function over the
 * bytes, and the fixture is a real PNG header, so the type decision under test
 * is the real one rather than a stub agreeing with itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../studio.repo.js", () => ({
  getBySlug: vi.fn(),
  updateStudio: vi.fn(),
}));

const { mockUpload } = vi.hoisted(() => ({ mockUpload: vi.fn() }));

vi.mock("@breatic/core", async (
  importOriginal: () => Promise<Record<string, unknown>>,
) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getStorageAdapter: vi.fn(async () => ({ upload: mockUpload })),
  };
});

import * as studioRepo from "../studio.repo.js";
import { setAvatar } from "../studioAvatar.service.js";

/** A PNG header the real sniffer accepts: signature + a 13-byte IHDR. */
const PNG_BYTES = (() => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(512, 0);
  ihdr.writeUInt32BE(512, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([sig, len, Buffer.from("IHDR", "ascii"), ihdr, Buffer.alloc(4)]);
})();

const STUDIO = { id: "11111111-2222-3333-4444-555555555555", slug: "a-studio" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(studioRepo.getBySlug).mockResolvedValue(
    STUDIO as unknown as Awaited<ReturnType<typeof studioRepo.getBySlug>>,
  );
  vi.mocked(studioRepo.updateStudio).mockImplementation(
    async (_id: string, patch: { avatarUrl?: string | null }) =>
      ({ ...STUDIO, avatarUrl: patch.avatarUrl }) as unknown as Awaited<
        ReturnType<typeof studioRepo.updateStudio>
      >,
  );
});

describe("setAvatar write order", () => {
  it("does not touch the row when the object cannot be stored", async () => {
    // The failure this order exists for: storage is down or the disk is full
    // mid-upload. Written the other way round, the studio would keep pointing
    // at an object that was never created — a broken image for every viewer,
    // with nothing to retry from, and no error anyone sees after the request.
    mockUpload.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(setAvatar(STUDIO.slug, PNG_BYTES)).rejects.toThrow(
      "storage unavailable",
    );

    expect(mockUpload).toHaveBeenCalledOnce();
    expect(studioRepo.updateStudio).not.toHaveBeenCalled();
  });

  it("stores the object before the row, not alongside it", async () => {
    // Ordering, not just presence: a call-order assertion is what fails when
    // the two statements are swapped, which the integration suite cannot see.
    const order: string[] = [];
    mockUpload.mockImplementationOnce(async () => {
      order.push("storage");
      return "https://cdn.example/avatar/x.png";
    });
    vi.mocked(studioRepo.updateStudio).mockImplementationOnce(async () => {
      order.push("database");
      return { ...STUDIO } as unknown as Awaited<
        ReturnType<typeof studioRepo.updateStudio>
      >;
    });

    await setAvatar(STUDIO.slug, PNG_BYTES);

    expect(order).toEqual(["storage", "database"]);
  });

  it("writes the URL the adapter returned, not one it built itself", async () => {
    // The adapter owns what a stored key resolves to publicly. Rebuilding that
    // string here would be a second source of truth that drifts the first time
    // a provider's URL shape changes.
    mockUpload.mockResolvedValueOnce("https://cdn.example/somewhere/else.png");

    await setAvatar(STUDIO.slug, PNG_BYTES);

    expect(studioRepo.updateStudio).toHaveBeenCalledWith(STUDIO.id, {
      avatarUrl: "https://cdn.example/somewhere/else.png",
    });
  });

  it("refuses before writing anything when the signature has no extension", async () => {
    await expect(
      setAvatar(STUDIO.slug, Buffer.from("this is not an image at all")),
    ).rejects.toMatchObject({ statusCode: 415 });

    expect(mockUpload).not.toHaveBeenCalled();
    expect(studioRepo.updateStudio).not.toHaveBeenCalled();
  });
});
