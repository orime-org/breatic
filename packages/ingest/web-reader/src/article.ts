// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a rendered page hands back to Node (inner#1664). Its scripts ran
 * first, so whatever arrives is read as untrusted.
 */

/** A page's title and article HTML. */
export interface Article {
  title: string;
  html: string;
}

/**
 * A value as a string, or the empty string when it is anything else.
 * @param value - The value.
 * @returns The string.
 */
function stringOr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Read what the page's evaluation returned as an article.
 * @param value - The evaluation's result.
 * @returns The title and HTML, each the empty string when it was not a string.
 * @throws {never} Never.
 */
export function articleOf(value: unknown): Article {
  if (value === null || typeof value !== "object") return { title: "", html: "" };
  const { title, html } = value as Record<string, unknown>;
  return { title: stringOr(title), html: stringOr(html) };
}
