// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The attribute a popup carries when it belongs to the text inside a modal
 * dialog although it is mounted outside the dialog's content, such as the `@`
 * list on the page body (inner#2115). A dialog treats a press in it as a press
 * inside, and the popup takes presses although a modal turns them off on the
 * page.
 */
export const KEEPS_DIALOG_OPEN = 'data-keeps-dialog-open';
