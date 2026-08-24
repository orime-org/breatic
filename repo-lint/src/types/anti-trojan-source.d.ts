// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Types for `anti-trojan-source`, which ships none.
 *
 * Declaring the shape we depend on rather than letting it be `any`: this is
 * the contract the check reads, so if a future version renames a field the
 * typecheck says so instead of the check silently finding nothing.
 */
declare module "anti-trojan-source" {
  /** One character the scanner objected to. */
  export interface Confusable {
    /** 1-based line. */
    line: number;
    /** 1-based column. */
    column: number;
    /** The offending code point, e.g. `U+202E`. */
    codePoint: string;
    /** Its Unicode name. */
    name: string;
    /** How dangerous the library considers it. */
    severity: string;
    /** Which class of invisible character it belongs to. */
    category: string;
  }

  /** The scanner's report for one file. */
  export interface ConfusableFile {
    /** Path as handed to the scanner. */
    file: string;
    /** Every objection in that file. */
    findings: Confusable[];
  }

  /** What the scanner is asked to look at. */
  export interface ScanOptions {
    /** Absolute paths to scan. */
    filePaths: string[];
    /** Return per-character findings rather than a boolean per file. */
    detailed?: boolean;
    /** Widen beyond the dangerous bidi / invisible subset. */
    extended?: boolean;
  }

  /**
   * Scans files for bidi and invisible characters.
   * @param options Which files to read and how much to report.
   * @returns One entry per file with findings; may be undefined when clean.
   */
  export function hasConfusablesInFiles(
    options: ScanOptions,
  ): Promise<ConfusableFile[] | undefined>;
}
