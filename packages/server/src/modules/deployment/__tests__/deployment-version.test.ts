// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDeploymentVersion } from "@server/modules/deployment/deployment-version.service.js";
import { readBusinessMigrationWatermark } from "@server/modules/deployment/migration-watermark.repo.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("@breatic/core", () => ({ MONOREPO_ROOT: "/app" }));
vi.mock("@server/modules/deployment/migration-watermark.repo.js", () => ({ readBusinessMigrationWatermark: vi.fn() }));

const release = { releaseVersion: "0.0.32", revision: "4b84ce849fa8572150c2d42eaada6908adb22e90" };

afterEach(() => vi.resetAllMocks());

describe("running deployment metadata", () => {
  it("reads the executing image and reports the actual and expected business migration watermarks separately", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify(release))
      .mockResolvedValueOnce(JSON.stringify({ entries: [{ when: 200 }, { when: 100 }] }));
    vi.mocked(readBusinessMigrationWatermark).mockResolvedValue({ count: 1, watermark: 100 });

    expect(await getDeploymentVersion()).toEqual({
      ...release,
      expectedBusinessMigration: { count: 2, watermark: 200 },
      actualBusinessMigration: { count: 1, watermark: 100 },
    });
    expect(readFile).toHaveBeenCalledWith("/app/build-info.json", "utf8");
  });

  it("rejects an image without a verifiable source revision", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ ...release, revision: "unknown" }));
    await expect(getDeploymentVersion()).rejects.toThrow();
    expect(readBusinessMigrationWatermark).not.toHaveBeenCalled();
  });
});
