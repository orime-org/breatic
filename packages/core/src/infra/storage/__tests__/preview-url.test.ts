// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The preview rule in `@breatic/shared` judges an address by the shape of the
 * key it ends in. These run it against keys the two key builders actually
 * produce, so a change to either builder that the rule no longer recognises
 * fails here.
 */

import { describe, it, expect } from "vitest";
import { previewUrlFor, originalUrlFor } from "@breatic/shared";
import { coverKeyFor, storageKey } from "@core/infra/storage/index.js";
import { S3StorageAdapter } from "@core/infra/storage/s3.js";

const store = new S3StorageAdapter({
  bucket: "assets",
  region: "auto",
  accessKeyId: "id",
  secretAccessKey: "secret",
  publicBaseUrl: "https://resource-dev.breatic.cc",
});

describe("previewUrlFor against real keys", () => {
  it("recognises an uploaded image's address", () => {
    const url = store.publicUrl(storageKey({ taskType: "image", ext: ".png" }));
    expect(previewUrlFor(url)).toBe(`${url}.preview.webp`);
  });

  it("recognises a video cover's address", () => {
    const video = storageKey({ taskType: "video", ext: ".mp4" });
    const url = store.publicUrl(coverKeyFor(video));
    expect(previewUrlFor(url)).toBe(`${url}.preview.webp`);
  });

  it("does not stack a preview on a preview", () => {
    const url = store.publicUrl(storageKey({ taskType: "image", ext: ".jpg" }));
    const preview = previewUrlFor(url);
    expect(preview).not.toBeNull();
    expect(previewUrlFor(preview ?? "")).toBeNull();
    expect(originalUrlFor(preview ?? "")).toBe(url);
  });
});
