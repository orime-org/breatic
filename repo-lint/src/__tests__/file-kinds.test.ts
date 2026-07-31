// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { isScannableText } from "#repo-lint/file-kinds";

describe("isScannableText", () => {
  it("accepts the tracked files that carry no extension at all", () => {
    // These are real tracked paths. An extension allowlist skipped every one
    // of them, which is how the env templates and the Dockerfiles ended up
    // outside the secret scan.
    for (const path of [
      "Dockerfile",
      "Dockerfile.web",
      ".env.dev",
      ".env.docker",
      ".husky/pre-commit",
      ".husky/commit-msg",
      "LICENSE",
      ".npmrc",
      ".gitignore",
    ]) {
      expect(isScannableText(path), path).toBe(true);
    }
  });

  it("accepts ordinary source and config", () => {
    for (const path of [
      "packages/core/src/index.ts",
      "packages/web/src/ui/BrandMark.tsx",
      "config/storage.yaml",
      "docs/ARCHITECTURE.md",
      "scripts/db-migrate.ts",
      "packages/web/src/index.html",
    ]) {
      expect(isScannableText(path), path).toBe(true);
    }
  });

  it("rejects bytes that are not text", () => {
    for (const path of [
      "packages/web/public/favicon.ico",
      "packages/web/src/assets/logo.png",
      "docs/diagram.pdf",
      "packages/web/src/assets/font.woff2",
      "fixtures/clip.mp4",
    ]) {
      expect(isScannableText(path), path).toBe(false);
    }
  });

  it("treats an SVG as text, because it is", () => {
    // Markup, not bytes: a private path or a bidi override hides in one just
    // as well as in a .ts file.
    expect(isScannableText("packages/web/src/assets/mark.svg")).toBe(true);
  });
});
