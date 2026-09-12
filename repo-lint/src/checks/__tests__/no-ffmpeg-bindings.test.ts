// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { noFfmpegBindings } from "#repo-lint/checks/no-ffmpeg-bindings";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * A manifest, a lockfile and one source file, so a case supplies only what it
 * is about. Every one of the three is a place a binding can arrive from.
 */
const BARE = {
  "package.json": "{}",
  "pnpm-lock.yaml": "importers:\n",
  "packages/worker/src/noop.ts": "export const noop = (): void => {};\n",
};

describe("no-ffmpeg-bindings", () => {
  it("passes a repository that only spawns the executable", () => {
    const context = fakeContext({
      ...BARE,
      "packages/worker/src/handlers/local/video/cut.ts": [
        'import { spawnCollected } from "@worker/lib/spawn";',
        "",
        "/** Cuts a clip. ffmpeg does the work; we only hand it arguments. */",
        "export async function cut(args: string[]): Promise<void> {",
        '  // ffprobe reads the duration first, then ffmpeg writes the clip.',
        '  await spawnCollected("ffmpeg", args);',
        "}",
      ].join("\n"),
    });
    expect(noFfmpegBindings.run(context)).toEqual([]);
  });

  it("reports a binding a manifest declares", () => {
    const context = fakeContext({
      ...BARE,
      "packages/worker/package.json":
        '{"dependencies":{"fluent-ffmpeg":"2.1.3"}}',
    });
    const findings = noFfmpegBindings.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/worker/package.json");
    expect(findings[0]?.message).toContain("fluent-ffmpeg");
    expect(findings[0]?.message).toContain("subprocess");
  });

  it("reports one in devDependencies too", () => {
    const context = fakeContext({
      ...BARE,
      "packages/worker/package.json":
        '{"devDependencies":{"ffmpeg-static":"5.2.0"}}',
    });
    expect(noFfmpegBindings.run(context)).toHaveLength(1);
  });

  it("reports every import form, with the line it is on", () => {
    const context = fakeContext({
      ...BARE,
      "packages/worker/src/a.ts": 'import ffmpeg from "fluent-ffmpeg";\n',
      "packages/worker/src/b.ts": 'const m = require("@ffmpeg/ffmpeg");\n',
      "packages/worker/src/c.ts":
        "const later = async (): Promise<unknown> =>\n" +
        '  await import("ffmpeg-static");\n',
    });
    const findings = noFfmpegBindings.run(context);
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.file).sort()).toEqual([
      "packages/worker/src/a.ts",
      "packages/worker/src/b.ts",
      "packages/worker/src/c.ts",
    ]);
    expect(findings.every((f) => typeof f.line === "number")).toBe(true);
  });

  it("reports a binding only the lockfile names", () => {
    // Something we do declare depends on it, so no manifest of ours says the
    // name and no source of ours imports it — and it is installed all the same.
    const context = fakeContext({
      ...BARE,
      "pnpm-lock.yaml": [
        "packages:",
        "  fluent-ffmpeg@2.1.3:",
        "    resolution: {integrity: sha512-fake}",
      ].join("\n"),
    });
    const findings = noFfmpegBindings.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("pnpm-lock.yaml");
    expect(findings[0]?.message).toContain("fluent-ffmpeg");
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
    const findings = noFfmpegBindings.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/worker/package.json");
  });

  it("passes a package whose name merely contains one of the words", () => {
    // The judge is the specifier, and these are ordinary packages that happen
    // to read as if they were bindings.
    const context = fakeContext({
      ...BARE,
      "packages/worker/src/d.ts": 'import x from "./ffmpeg-args.js";\n',
    });
    expect(noFfmpegBindings.run(context)).toEqual([]);
  });
});
