// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one title rule every web-animation row shows by (#1490 design §4.4, §7.1): a create is its request, a
 * modification is "modified from" its base's request with its own instruction, and an export is "video" of its
 * source's title. The execution list, the details, the annotation groups, the Timeline picker, clip names and the
 * conflict list all read it.
 */

/** A request with the base it modified, when it did. */
interface TitledRequest {
  request: string;
  base?: { executionId: string; request: string };
}

/** What a title is made from. */
export type WebAnimationTitleSource =
  | { kind: 'web_animation_create'; request: string }
  | { kind: 'web_animation_modify'; request: string; base: { executionId: string; request: string } }
  | { kind: 'web_animation_export'; source: TitledRequest & { executionId: string } };

/** The translator the title is written with. */
export type TitleTranslator = (key: string, params?: Record<string, string>) => string;

/**
 * The title of a create or a modification.
 * @param row - Its request and base.
 * @param t - The translator.
 * @returns The title.
 * @throws {never} Never.
 */
export function requestTitle(row: TitledRequest, t: TitleTranslator): string {
  if (row.base === undefined) return row.request;
  return t('spaces.webAnimation.titleModifiedFrom', { base: row.base.request, request: row.request });
}

/**
 * A web-animation row's title.
 * @param row - The row.
 * @param t - The translator.
 * @returns The title.
 * @throws {never} Never.
 */
export function webAnimationTitle(row: WebAnimationTitleSource, t: TitleTranslator): string {
  return row.kind === 'web_animation_export' ? t('spaces.webAnimation.titleVideo', { source: requestTitle(row.source, t) }) : requestTitle(row, t);
}
