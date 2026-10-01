// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Registers the comment mark on the body's schema (#18).
 *
 * The mark comes from the library, and with it the four spec values the
 * feature rests on: `excludes: ""` lets two comments overlap the same run,
 * `inclusive: false` keeps text typed at a comment's end outside it,
 * `keepOnSplit: true` carries it across Enter, and the `orphan` attribute is
 * the flag that stops a mark being painted once its thread is gone.
 *
 * This is the registrar for a body built with no thread store behind it —
 * the library's own comments extension is the other, and `commentWiring`
 * picks between them. What matters is that the mark is in the schema either
 * way: `DOCUMENT_SCHEMA_VERSION` is computed from the schema, so a mark that
 * came and went with a runtime option would make this build's vocabulary
 * depend on how the editor was constructed.
 */

import { createExtension } from '@blocknote/core';
import { CommentMark } from '@blocknote/core/comments';

export const documentCommentMarkExtension = createExtension(() => ({
  key: 'documentCommentMark',
  tiptapExtensions: [CommentMark],
}) as never);
