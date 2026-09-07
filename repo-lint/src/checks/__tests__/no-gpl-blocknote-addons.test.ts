// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { noGplBlocknoteAddons } from "#repo-lint/checks/no-gpl-blocknote-addons";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/** A manifest and a lockfile, so a case supplies only what it is about. */
const BARE = {
  "package.json": "{}",
  "pnpm-lock.yaml": "importers:\n",
};

describe("no-gpl-blocknote-addons", () => {
  it("passes on the two packages we take", () => {
    const context = fakeContext({
      ...BARE,
      "packages/web/package.json":
        '{"dependencies":{"@blocknote/core":"0.54.0","@blocknote/react":"0.54.0"}}',
    });
    expect(noGplBlocknoteAddons.run(context)).toEqual([]);
  });

  it("reports an xl package a manifest declares", () => {
    const context = fakeContext({
      ...BARE,
      "packages/web/package.json":
        '{"dependencies":{"@blocknote/xl-multi-column":"0.54.0"}}',
    });
    const findings = noGplBlocknoteAddons.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/web/package.json");
    expect(findings[0]?.message).toContain("@blocknote/xl-multi-column");
    expect(findings[0]?.message).toContain("GPL-3.0");
  });

  it("reports one in devDependencies too", () => {
    const context = fakeContext({
      ...BARE,
      "packages/web/package.json":
        '{"devDependencies":{"@blocknote/xl-pdf-exporter":"0.54.0"}}',
    });
    expect(noGplBlocknoteAddons.run(context)).toHaveLength(1);
  });

  it("says a declared one once, against the manifest, though the lockfile has it too", () => {
    // What a real checkout looks like: whatever a manifest declares is resolved
    // in the lockfile as well, and a second finding there names no other edit.
    const context = fakeContext({
      ...BARE,
      "packages/web/package.json":
        '{"dependencies":{"@blocknote/xl-ai":"0.54.0"}}',
      "pnpm-lock.yaml": [
        "importers:",
        "  packages/web:",
        "    dependencies:",
        "      '@blocknote/xl-ai':",
        "        specifier: 0.54.0",
        "        version: 0.54.0",
      ].join("\n"),
    });
    const findings = noGplBlocknoteAddons.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/web/package.json");
  });

  it("reports one that reached the lockfile without any manifest naming it", () => {
    // How it actually arrives: something we do declare depends on it, and no
    // manifest of ours mentions it at all.
    const context = fakeContext({
      ...BARE,
      "pnpm-lock.yaml": [
        "importers:",
        "  packages/web:",
        "    dependencies:",
        "      '@blocknote/xl-ai':",
        "        specifier: 0.54.0",
        "        version: 0.54.0",
      ].join("\n"),
    });
    const findings = noGplBlocknoteAddons.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("pnpm-lock.yaml");
    expect(findings[0]?.message).toContain("@blocknote/xl-ai");
  });

  it("says the same package once however many times the lockfile repeats it", () => {
    const context = fakeContext({
      ...BARE,
      "pnpm-lock.yaml": [
        "importers:",
        "  '@blocknote/xl-ai@0.54.0':",
        "  '@blocknote/xl-ai@0.54.0(react@19.0.0)':",
      ].join("\n"),
    });
    expect(noGplBlocknoteAddons.run(context)).toHaveLength(1);
  });
});
