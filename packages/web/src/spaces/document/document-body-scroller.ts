// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The class that names the body's scroll container.
 *
 * One definition because the stylesheet and the tests both reach the body
 * through it: `index.css` stretches the wrapper around the body to fill the
 * scroller (`:has(.doc-body-editor)`), and tests find the body's viewport by
 * it, apart from the heading outline's own scroller beside it.
 */
export const BODY_SCROLLER_CLASS = 'doc-body-scroller';

/**
 * The class on the row that holds the scroller and the heading outline beside
 * it, where the whole-document entry's layout variables are set
 * (`BODY_ROW_VARS`, `document-columns.ts`).
 */
export const BODY_ROW_CLASS = 'doc-body-row';
