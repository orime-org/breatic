// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * T29 (inner#1006 §4.2): a transfer never becomes an asset row, so
 * `StudioAssetEntity["source"]` does not take `"transfer"`, while a grant's
 * `assetSource` does. The grant's type lives here in domain
 * (`upload-grant.repo.ts` `UploadGrant.assetSource` and the `issueGrant`
 * context), not in shared. The assertions are on types and are checked by
 * `tsc --noEmit` (the package typecheck).
 */

import { describe, expect, it } from "vitest";

import type { StudioAssetEntity } from "@breatic/shared";
import type { UploadGrant } from "@domain/asset/upload-grant.repo.js";
import type { UploadFinishJob } from "@domain/asset/upload-finish.service.js";

describe("T29 transfer is a grant source, never an asset source", () => {
  it("refuses transfer as an asset row's source", () => {
    // @ts-expect-error -- "transfer" must never be a studio asset's source.
    const source: StudioAssetEntity["source"] = "transfer";
    expect(source).toBe("transfer");
  });

  it("takes transfer as a grant's and a finish job's assetSource", () => {
    const grant: UploadGrant["assetSource"] = "transfer";
    const job: UploadFinishJob["assetSource"] = "transfer";
    expect([grant, job]).toEqual(["transfer", "transfer"]);
  });
});
