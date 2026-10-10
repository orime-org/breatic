// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import {
  isStoredObjectUrl,
  originalUrlFor,
  previewKeyFor,
  previewUrlFor,
} from "@shared/upload/preview.js";

const BASE = "https://resource-dev.breatic.cc";
const UUID = "18f58aed-b802-4243-a8ea-02d377de9679";
const IMAGE_KEY = `image/2026-09-30/1790770458755_${UUID}.png`;
const COVER_KEY = `video/2026-09-30/1790770458755_${UUID}_cover.png`;

describe("previewKeyFor", () => {
  it("appends the preview suffix to a stored key", () => {
    expect(previewKeyFor(IMAGE_KEY)).toBe(`${IMAGE_KEY}.preview.webp`);
  });

  it("appends the preview suffix to a cover key", () => {
    expect(previewKeyFor(COVER_KEY)).toBe(`${COVER_KEY}.preview.webp`);
  });
});

describe("previewUrlFor", () => {
  it("gives the preview address of a stored image", () => {
    expect(previewUrlFor(`${BASE}/${IMAGE_KEY}`)).toBe(
      `${BASE}/${IMAGE_KEY}.preview.webp`,
    );
  });

  it("gives the preview address of a video cover", () => {
    expect(previewUrlFor(`${BASE}/${COVER_KEY}`)).toBe(
      `${BASE}/${COVER_KEY}.preview.webp`,
    );
  });

  it("accepts any extension case", () => {
    const url = `${BASE}/image/2026-09-30/1_${UUID}.JPG`;
    expect(previewUrlFor(url)).toBe(`${url}.preview.webp`);
  });

  it("returns null for an address that already is a preview", () => {
    expect(previewUrlFor(`${BASE}/${IMAGE_KEY}.preview.webp`)).toBeNull();
  });

  it("returns null for an external address", () => {
    expect(previewUrlFor("https://images.example.com/photo.png")).toBeNull();
  });

  it("returns null for a blob address", () => {
    expect(previewUrlFor(`blob:${BASE}/${UUID}`)).toBeNull();
  });

  it("returns null for a stored key with no extension", () => {
    expect(previewUrlFor(`${BASE}/image/2026-09-30/1_${UUID}`)).toBeNull();
  });

  it("ignores a query string after the key", () => {
    expect(previewUrlFor(`${BASE}/${IMAGE_KEY}?download=1`)).toBeNull();
  });
});

describe("originalUrlFor", () => {
  it("strips the preview suffix", () => {
    expect(originalUrlFor(`${BASE}/${IMAGE_KEY}.preview.webp`)).toBe(
      `${BASE}/${IMAGE_KEY}`,
    );
  });

  it("returns an original address unchanged", () => {
    expect(originalUrlFor(`${BASE}/${IMAGE_KEY}`)).toBe(`${BASE}/${IMAGE_KEY}`);
  });

  it("round-trips with previewUrlFor", () => {
    const original = `${BASE}/${COVER_KEY}`;
    const preview = previewUrlFor(original);
    expect(preview).not.toBeNull();
    expect(originalUrlFor(preview ?? "")).toBe(original);
  });
});

describe("isStoredObjectUrl", () => {
  it("accepts a stored original and a stored cover", () => {
    expect(isStoredObjectUrl(`${BASE}/${IMAGE_KEY}`)).toBe(true);
    expect(isStoredObjectUrl(`${BASE}/${COVER_KEY}`)).toBe(true);
  });

  it("rejects a preview, an external address and a non-http string", () => {
    expect(isStoredObjectUrl(`${BASE}/${IMAGE_KEY}.preview.webp`)).toBe(false);
    expect(isStoredObjectUrl("https://example.com/cat.png")).toBe(false);
    expect(isStoredObjectUrl(`blob:${BASE}/${IMAGE_KEY}`)).toBe(false);
    expect(isStoredObjectUrl("plain words")).toBe(false);
  });
});
