// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";

/**
 * The families every Timeline text clip is drawn with, in fallback order; the same files as the export container's
 * font set. The order matches the page's own `--font-sans` and decides which family each character takes.
 */
export const TIMELINE_TEXT_FONT_FAMILIES = ["Inter", "Noto Sans SC", "Noto Sans TC", "Noto Sans JP", "Noto Sans KR"] as const;

/** The fixed look of every Timeline text clip; the preview and the export both take it from here. */
export const TIMELINE_TEXT_STYLE = {
  color: "#ffffff",
  fontWeight: 600,
  lineHeight: 1.2,
  textShadow: "0 1px 3px rgba(0,0,0,0.6)",
  textAlign: "center",
  whiteSpace: "pre-wrap",
} as const;

/** One face of the font set's `faces.json`. */
export const TimelineFontFaceSchema = z.object({
  family: z.string().min(1),
  file: z.string().min(1),
  unicodeRange: z.string().min(1),
  weight: z.string().min(1).optional(),
});

/** The font set's `faces.json`. */
export const TimelineFontFacesSchema = z.array(TimelineFontFaceSchema);

/** One entry of the font set's `glyphs.json`: the characters a face file really holds; an empty face is left out. */
export const TimelineFontGlyphSchema = z.object({ file: z.string().min(1), glyphRange: z.string().min(1) });

/** The font set's `glyphs.json`. */
export const TimelineFontGlyphsSchema = z.array(TimelineFontGlyphSchema);

/** One face of `faces.json`. */
export type TimelineFontFace = z.infer<typeof TimelineFontFaceSchema>;

/** One entry of `glyphs.json`. */
export type TimelineFontGlyph = z.infer<typeof TimelineFontGlyphSchema>;

/**
 * Whether `glyphs.json` names each file at most once and only files `faces.json` holds.
 * @param faces - The parsed `faces.json`.
 * @param glyphs - The parsed `glyphs.json`.
 * @returns Whether the two files agree.
 * @throws {never} Never.
 */
export function timelineFontFilesMatch(faces: readonly TimelineFontFace[], glyphs: readonly TimelineFontGlyph[]): boolean {
  const files = new Set(faces.map((face) => face.file));
  const seen = new Set<string>();
  for (const { file } of glyphs) {
    if (!files.has(file) || seen.has(file)) return false;
    seen.add(file);
  }
  return true;
}
