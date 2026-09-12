// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLicenceNotice } from "#repo-lint/licence-notice";
import type { LicensedPackage } from "#repo-lint/licence-coverage";

/**
 * A package directory on disk, optionally carrying a licence file.
 * @param name - The package name, used for the directory.
 * @param file - The licence file to write, when the package ships one.
 * @returns The absolute path the report would carry in `paths`.
 */
function packageDir(
  name: string,
  file?: { readonly named: string; readonly holding: string },
): string {
  const root = mkdtempSync(join(tmpdir(), "licence-notice-"));
  const dir = join(root, name.replaceAll("/", "+"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  if (file) writeFileSync(join(dir, file.named), file.holding);
  return dir;
}

/**
 * One entry shaped the way `pnpm licenses list --json` reports it.
 * @param name - The package name.
 * @param versions - Every installed version of it.
 * @param paths - Where each of those versions sits on disk.
 * @param licence - The SPDX identifier the report carries.
 * @returns The entry.
 */
function entry(
  name: string,
  versions: string[],
  paths: string[],
  licence: string,
): LicensedPackage {
  return { name, versions, paths, license: licence, homepage: "" };
}

describe("buildLicenceNotice", () => {
  it("produces one entry per package the report names", () => {
    const groups = {
      MIT: [
        entry("alpha", ["1.0.0"], [packageDir("alpha")], "MIT"),
        entry("beta", ["2.0.0"], [packageDir("beta")], "MIT"),
      ],
    };

    const notice = buildLicenceNotice(groups);

    expect(notice).toContain("alpha");
    expect(notice).toContain("1.0.0");
    expect(notice).toContain("beta");
    expect(notice).toContain("2.0.0");
  });

  it("carries the licence file from disk verbatim", () => {
    const text =
      "MIT License\n\nCopyright (c) 2021, Claudéric Demers\n\n" +
      "Permission is hereby granted, free of charge, to any person obtaining a copy\n";
    const dir = packageDir("gamma", { named: "LICENSE", holding: text });
    const groups = { MIT: [entry("gamma", ["1.0.0"], [dir], "MIT")] };

    const notice = buildLicenceNotice(groups);

    expect(notice).toContain(text.trim());
  });

  it("reads a licence file whatever upstream named it", () => {
    const dir = packageDir("delta", {
      named: "LICENSE.markdown",
      holding:
        "JSZip is dual licensed. At your choice.\n\n" +
        "Permission is hereby granted, free of charge, to any person.",
    });
    const groups = { MIT: [entry("delta", ["1.0.0"], [dir], "MIT")] };

    expect(buildLicenceNotice(groups)).toContain(
      "JSZip is dual licensed. At your choice.",
    );
  });

  it("falls back to a standard text for each licence a package ships none of", () => {
    const groups = {
      MIT: [entry("no-file-mit", ["1.0.0"], [packageDir("no-file-mit")], "MIT")],
      "Apache-2.0": [
        entry(
          "no-file-apache",
          ["1.0.0"],
          [packageDir("no-file-apache")],
          "Apache-2.0",
        ),
      ],
      "BSD-2-Clause": [
        entry(
          "no-file-bsd",
          ["1.0.0"],
          [packageDir("no-file-bsd")],
          "BSD-2-Clause",
        ),
      ],
    };

    const notice = buildLicenceNotice(groups);

    expect(notice).toContain("no-file-mit");
    expect(notice).toContain("no-file-apache");
    expect(notice).toContain("no-file-bsd");
    expect(notice).toContain("Permission is hereby granted, free of charge");
    expect(notice).toContain("Apache License");
    expect(notice).toContain("Redistributions of source code must retain");
  });

  it("prints one shared text once, however many packages carry the same words", () => {
    const words = "MIT License\n\nPermission is hereby granted, free of charge";
    const groups = {
      MIT: [
        entry(
          "twin-a",
          ["1.0.0"],
          [packageDir("twin-a", { named: "LICENSE", holding: words })],
          "MIT",
        ),
        entry(
          "twin-b",
          ["1.0.0"],
          [packageDir("twin-b", { named: "LICENSE", holding: words })],
          "MIT",
        ),
      ],
    };

    const notice = buildLicenceNotice(groups);

    expect(notice.split("Permission is hereby granted, free of charge")).toHaveLength(2);
    expect(notice).toContain("twin-a");
    expect(notice).toContain("twin-b");
  });

  it("renders a multi-version package as one entry listing every version", () => {
    const first = packageDir("multi", {
      named: "LICENSE",
      holding:
        "MIT License\n\nCopyright (c) 2020 Someone\n\n" +
        "Permission is hereby granted, free of charge, to any person.",
    });
    const second = packageDir("multi");
    const groups = {
      MIT: [entry("multi", ["1.0.1", "1.3.3"], [first, second], "MIT")],
    };

    const notice = buildLicenceNotice(groups);

    expect(notice.split(/^multi /m)).toHaveLength(2);
    expect(notice).toContain("1.0.1");
    expect(notice).toContain("1.3.3");
    expect(notice).toContain("Copyright (c) 2020 Someone");
  });

  it("leaves the homepage column out when the report carries no homepage", () => {
    const dir = packageDir("no-home", {
      named: "LICENSE",
      holding: "MIT License\n\nPermission is hereby granted.",
    });
    const groups = {
      MIT: [
        {
          name: "no-home",
          versions: ["1.0.0"],
          paths: [dir],
          license: "MIT",
        } as LicensedPackage,
      ],
    };

    expect(buildLicenceNotice(groups)).not.toContain("undefined");
  });

  it("leaves out a package installed only on one platform, whose bytes no browser receives", () => {
    const native = mkdtempSync(join(tmpdir(), "licence-notice-"));
    const dir = join(native, "napi-darwin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "napi-darwin", os: ["darwin"], cpu: ["arm64"] }),
    );
    writeFileSync(
      join(dir, "LICENSE"),
      "MIT License\n\nCopyright (c) 2024 Someone\n\nPermission is hereby granted.",
    );
    const groups = {
      MIT: [
        entry("kept", ["1.0.0"], [packageDir("kept", { named: "LICENSE", holding: "MIT License" })], "MIT"),
        entry("napi-darwin", ["1.0.0"], [dir], "MIT"),
      ],
    };

    const notice = buildLicenceNotice(groups);

    expect(notice).toContain("kept");
    expect(notice).not.toContain("napi-darwin");
    expect(notice).toContain("Packages 1,");
  });

  it("treats a file that only points elsewhere as no licence file", () => {
    const dir = packageDir("pointer", {
      named: "LICENSE.md",
      holding: "Apache License 2.0\n\nSee the LICENSE file in the root of this repository.",
    });
    const groups = {
      "Apache-2.0": [entry("pointer", ["1.0.0"], [dir], "Apache-2.0")],
    };

    const notice = buildLicenceNotice(groups);

    expect(notice).toContain("pointer");
    expect(notice).not.toContain("See the LICENSE file in the root");
    expect(notice).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
  });

  it("keeps the short form Apache recommends, which is a licence notice", () => {
    const shortForm = [
      "Copyright 2023 Someone, Inc.",
      "",
      'Licensed under the Apache License, Version 2.0 (the "License");',
      "you may not use this file except in compliance with the License.",
      "You may obtain a copy of the License at",
      "",
      "    http://www.apache.org/licenses/LICENSE-2.0",
    ].join("\n");
    const dir = packageDir("short-form", { named: "LICENSE", holding: shortForm });
    const groups = {
      "Apache-2.0": [entry("short-form", ["1.0.0"], [dir], "Apache-2.0")],
    };

    expect(buildLicenceNotice(groups)).toContain("Copyright 2023 Someone, Inc.");
  });

  it("keeps an Apache text that carries no appendix, as pdfjs-dist ships", () => {
    const body = [
      "                                 Apache License",
      "                           Version 2.0, January 2004",
      "",
      "   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
      "",
      "   1. Definitions. Distinctive words follow here.",
    ].join("\n");
    const dir = packageDir("no-appendix", { named: "LICENSE", holding: body });
    const groups = {
      "Apache-2.0": [entry("no-appendix", ["1.0.0"], [dir], "Apache-2.0")],
    };

    expect(buildLicenceNotice(groups)).toContain("Distinctive words follow here.");
  });

  it("refuses to write half a notice when a licence has neither file nor standard text", () => {
    const groups = {
      "Made-Up-1.0": [
        entry("orphan", ["1.0.0"], [packageDir("orphan")], "Made-Up-1.0"),
      ],
    };

    expect(() => buildLicenceNotice(groups)).toThrow(/Made-Up-1.0/);
  });

  it("gives byte-identical output for the same input, so the committed copy can be compared", () => {
    const dir = packageDir("alpha", {
      named: "LICENSE",
      holding: "MIT License\n\nPermission is hereby granted, free of charge.",
    });
    const groups = { MIT: [entry("alpha", ["1.0.0"], [dir], "MIT")] };

    expect(buildLicenceNotice(groups)).toBe(buildLicenceNotice(groups));
    expect(buildLicenceNotice(groups)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
