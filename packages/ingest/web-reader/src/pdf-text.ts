// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** A PDF's text, every page of it (inner#1664). */
import { extractText, getDocumentProxy } from "unpdf";

/**
 * Read every page's text out of a PDF.
 * @param bytes - The PDF.
 * @returns Its text, the pages joined, and how many pages it has.
 * @throws {Error} When the bytes are not a PDF the parser can read.
 */
export async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text, pages: totalPages };
}
