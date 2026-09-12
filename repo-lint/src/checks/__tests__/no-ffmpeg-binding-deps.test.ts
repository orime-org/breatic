// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { FFMPEG_BINDING_WORDS } from "@breatic/eslint-rules";
import {
  BINDING_WORDS,
  noFfmpegBindingDeps,
} from "#repo-lint/checks/no-ffmpeg-binding-deps";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * The two places this check reads, each holding nothing. A case supplies only
 * the one it is about.
 */
const BARE = {
  "package.json": "{}",
  "pnpm-lock.yaml": "importers:\n",
};

describe("no-ffmpeg-binding-deps", () => {
  it("reads the same word list as the ESLint half", () => {
    // The two halves answer the same question about the same names. Kept as
    // two copies, one of them goes stale the first time the list grows and
    // the gap is only visible to whoever remembers there were two.
    expect(FFMPEG_BINDING_WORDS).toContain("ffmpeg");
    expect(FFMPEG_BINDING_WORDS.length).toBeGreaterThan(1);
    expect(BINDING_WORDS).toBe(FFMPEG_BINDING_WORDS);
  });

  it("passes a repository whose manifests and lockfile name no binding", () => {
    const context = fakeContext({
      ...BARE,
      "packages/worker/package.json": '{"dependencies":{"execa":"9.6.0"}}',
      "pnpm-lock.yaml": [
        "packages:",
        "  execa@9.6.0:",
        "    resolution: {integrity: sha512-fake}",
        "  '@types/node@22.10.2':",
        "    resolution: {integrity: sha512-fake}",
      ].join("\n"),
    });
    expect(noFfmpegBindingDeps.run(context)).toEqual([]);
  });

  it("reports a binding a manifest declares", () => {
    const context = fakeContext({
      ...BARE,
      "packages/worker/package.json":
        '{"dependencies":{"fluent-ffmpeg":"2.1.3"}}',
    });
    const findings = noFfmpegBindingDeps.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/worker/package.json");
    expect(findings[0]?.message).toContain("fluent-ffmpeg");
    expect(findings[0]?.message).toContain("subprocess");
  });

  it.each([
    ["dependencies", "fluent-ffmpeg"],
    ["devDependencies", "ffmpeg-static"],
    ["optionalDependencies", "@ffmpeg-installer/ffmpeg"],
    ["peerDependencies", "@ffmpeg/ffmpeg"],
  ])("reports one declared in %s", (section, name) => {
    // Every section pnpm installs from. A binding declared in any of them is
    // on disk and loadable; which key it sits under changes nothing.
    const context = fakeContext({
      ...BARE,
      "packages/worker/package.json": JSON.stringify({
        [section]: { [name]: "1.0.0" },
      }),
    });
    const findings = noFfmpegBindingDeps.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(name);
  });

  it("reports a binding only the lockfile names", () => {
    // Something we do declare depends on it, so no manifest of ours says the
    // name and no source of ours imports it — and it is installed all the same.
    // pnpm quotes a scoped resolution key and leaves an unscoped one bare, and
    // the real file is 1645 quoted keys to 1013 bare ones, so both shapes are
    // here: a scan that reads only the bare form is blind to every `@scope/`
    // package, which is the shape `@ffmpeg/ffmpeg` and `@ffmpeg/core` have.
    const context = fakeContext({
      ...BARE,
      "pnpm-lock.yaml": [
        "packages:",
        "  fluent-ffmpeg@2.1.3:",
        "    resolution: {integrity: sha512-fake}",
        "  '@ffmpeg/ffmpeg@0.12.15':",
        "    resolution: {integrity: sha512-fake}",
        "  '@ffmpeg/core@0.12.10':",
        "    resolution: {integrity: sha512-fake}",
      ].join("\n"),
    });
    const findings = noFfmpegBindingDeps.run(context);
    expect(findings.map((finding) => finding.file)).toEqual([
      "pnpm-lock.yaml",
      "pnpm-lock.yaml",
      "pnpm-lock.yaml",
    ]);
    const said = findings.map((finding) => finding.message).join("\n");
    expect(said).toContain("@ffmpeg/core");
    expect(said).toContain("@ffmpeg/ffmpeg");
    expect(said).toContain("fluent-ffmpeg");
  });

  it("says a declared binding once, against the manifest", () => {
    const context = fakeContext({
      ...BARE,
      "packages/worker/package.json":
        '{"dependencies":{"fluent-ffmpeg":"2.1.3"}}',
      "pnpm-lock.yaml": [
        "packages:",
        "  fluent-ffmpeg@2.1.3:",
        "    resolution: {integrity: sha512-fake}",
      ].join("\n"),
    });
    const findings = noFfmpegBindingDeps.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/worker/package.json");
  });

});
