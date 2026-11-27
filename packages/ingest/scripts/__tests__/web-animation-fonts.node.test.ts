// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * `glyphs.json`, the glyph ranges `scripts/web-animation-fonts.mjs` writes beside `faces.json` in every version
 * directory (inner#1709 design §5.3).
 *
 * A face's `unicodeRange` is Google Fonts' shared subset range, wider than the glyphs the slice holds, so the Timeline
 * preview registers each slice with its `glyphRange` instead: the code points fontkit reads from the woff2, cut to the
 * `unicodeRange`, then made disjoint inside each family by giving every code point to the last face in `faces.json`
 * order that has its glyph (the face CSS Fonts 4 §4.5 has an export look at first). A face left with nothing is not
 * written. `faces.json` itself never changes: a version's files are served immutable for a year
 * (`assets/_headers`).
 *
 * The script runs for real into a throwaway directory; the expected ownership is recomputed here from the laid-out
 * woff2 files with the same fontkit the script pins.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { TIMELINE_TEXT_FONT_FAMILIES, TimelineFontFacesSchema, TimelineFontGlyphsSchema, timelineFontFilesMatch } from "@breatic/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Face {
  family: string;
  file: string;
  unicodeRange: string;
  weight?: string;
}

interface Glyphs {
  file: string;
  glyphRange: string;
}

/** The part of fontkit 2.0.4 this test reads: the code points a font's cmap maps. */
interface Fontkit {
  openSync(path: string): { characterSet: number[] };
}

const PKG = resolve(__dirname, "../..");
/** The font set the Timeline preview reads, as `config/timeline.yaml` names it. */
const FONT_SET_VERSION = /font_set_version:\s*(\d+)/.exec(readFileSync(resolve(PKG, "../../config/timeline.yaml"), "utf8"))?.[1];
const SCRIPT = resolve(__dirname, "../web-animation-fonts.mjs");

/**
 * sha256 of each version's `faces.json` as released, before `glyphs.json` existed. A served version is immutable.
 */
const RELEASED_FACES_SHA256: Record<string, string> = {
  v1: "25fca6de63c6afe523614f52a6e6fb5083dbfb6b050b1fb916834aa09f88393e",
  v2: "4a9eba85d699f2f79acfc29e148235c9fb2bef07c7247efc49673f5f5cf9a2c1",
  v3: "a36fd8e5805e72644813c279ea344d3037928c559e3938f0ca1f7819b8fcd1ef",
};

/** The seven v3 faces left empty once each family's ranges are disjoint (design §5.3). */
const V3_OMITTED = [
  "noto-sans-sc-98-wght-normal",
  "noto-sans-sc-99-wght-normal",
  "noto-serif-sc-98-wght-normal",
  "noto-serif-sc-99-wght-normal",
  "noto-sans-tc-96-wght-normal",
  "noto-sans-tc-102-wght-normal",
  "noto-sans-tc-103-wght-normal",
];

let out = "";
let versions: string[] = [];

/**
 * The faces of one laid-out version.
 * @param version - Its directory name.
 * @returns Its faces, in file order.
 */
function facesOf(version: string): Face[] {
  return JSON.parse(readFileSync(join(out, version, "faces.json"), "utf8")) as Face[];
}

/**
 * The glyph ranges of one laid-out version.
 * @param version - Its directory name.
 * @returns Its entries, in file order.
 */
function glyphsOf(version: string): Glyphs[] {
  return JSON.parse(readFileSync(join(out, version, "glyphs.json"), "utf8")) as Glyphs[];
}

/**
 * Every code point one CSS unicode-range value names.
 * @param range - A comma-separated unicode-range value.
 * @returns The code points, ascending.
 * @throws {Error} When a part is not a unicode-range token.
 */
function codePointsOf(range: string): number[] {
  const points = new Set<number>();
  for (const part of range.split(",")) {
    const token = part.trim();
    if (!/^U\+[0-9A-F?]{1,6}(-[0-9A-F]{1,6})?$/i.test(token)) throw new Error(`not a unicode-range token: "${token}"`);
    const body = token.slice(2);
    const [low, high] = body.includes("-")
      ? body.split("-").map((hex) => Number.parseInt(hex, 16))
      : [Number.parseInt(body.replace(/\?/g, "0"), 16), Number.parseInt(body.replace(/\?/g, "F"), 16)];
    for (let point = low!; point <= high!; point += 1) points.add(point);
  }
  return [...points].sort((a, b) => a - b);
}

/**
 * Loads fontkit, which this package pins as a devDependency for the font script.
 * @returns Its module.
 */
async function loadFontkit(): Promise<Fontkit> {
  const name = "fontkit";
  return (await import(/* @vite-ignore */ name)) as Fontkit;
}

/**
 * Who owns each code point of one version, recomputed from its woff2 files: per family, the last face in `faces.json`
 * order whose glyphs, cut to its `unicodeRange`, hold the point.
 * @param fontkit - The font reader.
 * @param version - Its directory name.
 * @returns Each owning face's file mapped to its code points, ascending; faces owning nothing are absent.
 */
function expectedOwnership(fontkit: Fontkit, version: string): Map<string, number[]> {
  const owner = new Map<string, string>();
  for (const face of facesOf(version)) {
    const range = new Set(codePointsOf(face.unicodeRange));
    const { characterSet } = fontkit.openSync(join(out, version, `${face.file}.woff2`));
    for (const point of characterSet) if (range.has(point)) owner.set(`${face.family}\u0000${String(point)}`, face.file);
  }
  const owned = new Map<string, number[]>();
  for (const [key, file] of owner) {
    const point = Number(key.split("\u0000")[1]);
    owned.set(file, [...(owned.get(file) ?? []), point]);
  }
  for (const points of owned.values()) points.sort((a, b) => a - b);
  return owned;
}

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "web-animation-glyphs-"));
  execFileSync(process.execPath, [SCRIPT, out]);
  versions = readdirSync(out)
    .filter((name) => /^v\d+$/.test(name))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}, 300_000);

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("glyphs.json in every version directory", () => {
  it("is written beside faces.json in every version laid out, as a list of { file, glyphRange }", () => {
    expect(versions).toEqual(["v1", "v2", "v3"]);
    for (const version of versions) {
      expect(existsSync(join(out, version, "glyphs.json")), `${version}/glyphs.json`).toBe(true);
      const glyphs = glyphsOf(version);
      expect(glyphs.length).toBeGreaterThan(0);
      for (const entry of glyphs) {
        expect(Object.keys(entry).sort()).toEqual(["file", "glyphRange"]);
        expect(typeof entry.file).toBe("string");
        expect(typeof entry.glyphRange).toBe("string");
      }
    }
  });

  it("names each face of faces.json at most once and nothing faces.json does not lay out", () => {
    for (const version of versions) {
      const files = glyphsOf(version).map((entry) => entry.file);
      const faces = new Set(facesOf(version).map((face) => face.file));
      expect(new Set(files).size, version).toBe(files.length);
      expect(files.filter((file) => !faces.has(file)), version).toEqual([]);
    }
  });

  it("gives every entry a non-empty glyphRange inside its face's unicodeRange", () => {
    for (const version of versions) {
      const faces = new Map(facesOf(version).map((face) => [face.file, face]));
      for (const entry of glyphsOf(version)) {
        const points = codePointsOf(entry.glyphRange);
        expect(points.length, `${version} ${entry.file}`).toBeGreaterThan(0);
        const range = new Set(codePointsOf(faces.get(entry.file)!.unicodeRange));
        expect(points.filter((point) => !range.has(point)), `${version} ${entry.file}`).toEqual([]);
      }
    }
  });

  it("keeps the glyph ranges of one family disjoint", () => {
    for (const version of versions) {
      const familyOf = new Map(facesOf(version).map((face) => [face.file, face.family]));
      const seen = new Map<string, string>();
      const shared: string[] = [];
      for (const entry of glyphsOf(version)) {
        for (const point of codePointsOf(entry.glyphRange)) {
          const key = `${familyOf.get(entry.file)!}\u0000${String(point)}`;
          const first = seen.get(key);
          if (first !== undefined) shared.push(`${version} U+${point.toString(16)} in ${first} and ${entry.file}`);
          seen.set(key, entry.file);
        }
      }
      expect(shared).toEqual([]);
    }
  });

  it("gives each code point to the last face of its family in faces.json order that has its glyph", async () => {
    const fontkit = await loadFontkit();
    for (const version of versions) {
      const expected = expectedOwnership(fontkit, version);
      const actual = new Map(glyphsOf(version).map((entry) => [entry.file, codePointsOf(entry.glyphRange)]));
      expect([...actual.keys()].sort(), version).toEqual([...expected.keys()].sort());
      for (const [file, points] of expected) expect(actual.get(file), `${version} ${file}`).toEqual(points);
    }
  }, 300_000);

  it("leaves out exactly the seven v3 faces design §5.3 lists, whose glyphs all belong to a later latin, latin-ext or vietnamese face of the family", async () => {
    const faces = facesOf("v3");
    const written = new Set(glyphsOf("v3").map((entry) => entry.file));
    expect(faces.map((face) => face.file).filter((file) => !written.has(file))).toEqual(V3_OMITTED);

    const fontkit = await loadFontkit();
    const ownerOf = new Map<string, string>();
    for (const entry of glyphsOf("v3")) {
      const family = faces.find((face) => face.file === entry.file)!.family;
      for (const point of codePointsOf(entry.glyphRange)) ownerOf.set(`${family}\u0000${String(point)}`, entry.file);
    }
    for (const file of V3_OMITTED) {
      const index = faces.findIndex((face) => face.file === file);
      const face = faces[index]!;
      const range = new Set(codePointsOf(face.unicodeRange));
      const points = fontkit.openSync(join(out, "v3", `${file}.woff2`)).characterSet.filter((point) => range.has(point));
      expect(points.length, file).toBeGreaterThan(0);
      for (const point of points) {
        const owner = ownerOf.get(`${face.family}\u0000${String(point)}`);
        expect(owner, `${file} U+${point.toString(16)}`).toMatch(/-(latin|latin-ext|vietnamese)-wght-normal$/);
        expect(faces.findIndex((other) => other.file === owner), `${file} U+${point.toString(16)}`).toBeGreaterThan(index);
        expect(faces.find((other) => other.file === owner)!.family).toBe(face.family);
      }
    }
  }, 300_000);

  it("writes each earlier version's entries exactly as the latest version writes them for the families it holds", () => {
    const latest = new Map(glyphsOf(versions.at(-1)!).map((entry) => [entry.file, entry.glyphRange]));
    for (const version of versions.slice(0, -1)) {
      const files = new Set(facesOf(version).map((face) => face.file));
      const expected = [...latest].filter(([file]) => files.has(file)).sort(([a], [b]) => a.localeCompare(b));
      const actual = glyphsOf(version)
        .map((entry): [string, string] => [entry.file, entry.glyphRange])
        .sort(([a], [b]) => a.localeCompare(b));
      expect(actual, version).toEqual(expected);
    }
  });
});

describe("faces.json", () => {
  it("stays byte for byte as each version was released", () => {
    for (const [version, sha256] of Object.entries(RELEASED_FACES_SHA256)) {
      const bytes = readFileSync(join(out, version, "faces.json"));
      expect(createHash("sha256").update(bytes).digest("hex"), version).toBe(sha256);
    }
  });
});

describe("the font reader", () => {
  it("is fontkit 2.0.4, pinned as a devDependency of this package", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies.fontkit).toBe("2.0.4");
  });
});

describe("what the Timeline preview reads (inner#1709 design §2.3, §5.3)", () => {
  it("parses every version's faces.json and glyphs.json with the shared schemas, the two files agreeing", () => {
    for (const version of versions) {
      const faces = TimelineFontFacesSchema.parse(facesOf(version));
      const glyphs = TimelineFontGlyphsSchema.parse(glyphsOf(version));
      expect(timelineFontFilesMatch(faces, glyphs), version).toBe(true);
    }
  });

  it("registers in the configured version every family of the preview's font stack", () => {
    expect(FONT_SET_VERSION).toBeDefined();
    const families = new Set(facesOf(`v${String(FONT_SET_VERSION)}`).map((face) => face.family));
    for (const family of TIMELINE_TEXT_FONT_FAMILIES) expect(families, family).toContain(family);
  });
});
