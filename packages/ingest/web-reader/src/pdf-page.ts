// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** A downloaded file read as a PDF page (inner#1664). */
import type { ReadPageResult } from "@shared/agent/read-pages.js";

import { pdfText } from "./pdf-text.js";

/**
 * Whether a file starts with the PDF signature.
 * @param bytes - The file.
 * @returns True when it starts `%PDF-`.
 * @throws {never} Never.
 */
export function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
}

/**
 * Read a downloaded file as a PDF.
 *
 * Bytes that are not a PDF, and a PDF the parser cannot open (encrypted,
 * corrupt), are a page of a type this reader cannot read.
 * @param url - The page asked for.
 * @param finalUrl - Where the file came from.
 * @param bytes - The file.
 * @returns The page.
 * @throws {never} Never.
 */
export async function readPdf(url: string, finalUrl: string, bytes: Uint8Array): Promise<ReadPageResult> {
  if (!isPdf(bytes)) {
    return { url, status: "unsupported_type", finalUrl };
  }
  let read: { text: string; pages: number };
  try {
    read = await pdfText(bytes);
  } catch {
    return { url, status: "unsupported_type", finalUrl };
  }
  const { text, pages } = read;
  if (text.trim() === "") return { url, status: "empty", finalUrl, kind: "pdf", pages };
  return { url, status: "ok", finalUrl, kind: "pdf", pages, text };
}
