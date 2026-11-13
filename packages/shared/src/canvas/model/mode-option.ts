// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** One selectable generation mode. */
export interface ModeOption {
  /** The mode id written to the node (`t2i` / `i2v` / …). */
  value: string;
  /**
   * Display label — English only, never localized (user 2026-07-10 item 15).
   * These are product mode names in the do-not-translate spirit of the DNT
   * glossary, so they read identically across all locales.
   */
  label: string;
  /** Stable test id for this option row. */
  testId: string;
}
