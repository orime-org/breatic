// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The text of a PDF the reader downloaded (inner#1664). */

/**
 * Every page's text in a PDF.
 * @param bytes - The PDF's bytes.
 * @returns The text of all pages, and how many pages there are.
 * @throws {Error} Always, until implemented.
 */
export async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  void bytes;
  throw new Error("not implemented: pdfText");
}
