// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { BODY_GUTTER_END, COMMENT_PANEL_WIDTH, OUTLINE_WIDTH } from '@web/spaces/document/document-columns';
import { BODY_GUTTER_START } from '@web/spaces/document/document-strip-alignment';

/**
 * The narrowest body text the outline leaves when it takes its own column:
 * the width seen with the outline and the comment panel both open in a
 * 960px Space, a 960px window with the Agent column shut (inner#1149 A17).
 */
const MIN_TEXT_WIDTH = 304;

/**
 * Whether the open outline takes its own column or floats over the body.
 * @param input - What the decision reads.
 * @param input.spaceWidth - The document Space's width.
 * @param input.commentsOpen - Whether the comment panel is open beside the body.
 * @returns `tiled` while the body text keeps at least 304px beside it, otherwise `floating`.
 */
export function outlineLayout({ spaceWidth, commentsOpen }: { spaceWidth: number; commentsOpen: boolean }): 'tiled' | 'floating' {
  const text = spaceWidth - OUTLINE_WIDTH - BODY_GUTTER_START - BODY_GUTTER_END - (commentsOpen ? COMMENT_PANEL_WIDTH : 0);
  return text >= MIN_TEXT_WIDTH ? 'tiled' : 'floating';
}
