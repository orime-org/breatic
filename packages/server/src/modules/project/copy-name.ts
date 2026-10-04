// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { PROJECT_NAME_MAX_CHARS, t } from "@breatic/shared";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Name a copy in the reader's language, the copy mark in front so it shows
 * even when a card cuts a long name short.
 *
 * The source name is shortened so the whole stays within the project name
 * limit (counted in UTF-16 code units, as that limit is), cut only between
 * characters the reader sees as one, and with no whitespace left at the end:
 * every rename entry trims, so a trailing space would be taken for an edit
 * the moment the name was opened.
 * @param sourceName - The name of the project being copied
 * @returns The copy's name
 */
export function copyName(sourceName: string): string {
  const room = PROJECT_NAME_MAX_CHARS - t("server.project.copy_name", { name: "" }).length;
  let kept = "";
  for (const { segment } of graphemes.segment(sourceName)) {
    if (kept.length + segment.length > room) break;
    kept += segment;
  }
  return t("server.project.copy_name", { name: kept.trimEnd() });
}
