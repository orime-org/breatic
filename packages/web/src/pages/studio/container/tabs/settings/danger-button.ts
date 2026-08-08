// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The look of a button whose action cannot be taken back once confirmed.
 *
 * Used by deleting, leaving, and changing the slug. Transferring is the one
 * action in this box that does NOT wear it: it dispatches an offer the
 * recipient has to accept, so nothing has happened yet and it can still be
 * withdrawn. Every one of the four opens a dialog first, so pressing is never
 * the point of no return — confirming is, and the red outline marks the ones
 * where confirming ends it.
 */
export const DANGER_BUTTON =
  'h-[30px] rounded-chrome border border-status-error-foreground px-3 text-xs font-medium text-status-error-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';
