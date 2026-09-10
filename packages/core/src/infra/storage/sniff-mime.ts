// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Backend-authoritative MIME sniffing (#1826, design §4.2) — derives a file's
 * real content type from its BYTES, never from a client claim. Its caller is
 * `setAvatar`, which admits an avatar only when the type derived here has an
 * extension in its accepted list.
 *
 * Two layers:
 *   1. magic-bytes (`file-type`) for binary formats with a signature;
 *   2. content-aware fallback for signature-less formats — `file-type` returns
 *      undefined for SVG (XML text) and CSV/JSON/TXT (plain text). Answering
 *      octet-stream for those classifies them as 'file' (`detectAssetKind`),
 *      so: an `<svg` root → image/svg+xml; otherwise, a blob with no WHATWG
 *      binary-data byte → text/plain (`detectAssetKind` → document); only a
 *      genuinely binary blob → application/octet-stream.
 */

import { fileTypeFromBuffer } from "file-type";

/** SVG root element — an `<svg` followed by whitespace, `/`, or `>`. */
const SVG_ROOT = /<svg[\s/>]/i;

/** How many leading bytes the content-aware fallback inspects. */
const SNIFF_WINDOW = 1024;

/**
 * Does the window contain a WHATWG "binary data byte"? Per the MIME Sniffing
 * Standard these are 0x00-0x08, 0x0B, 0x0E-0x1A, 0x1C-0x1F (control bytes that
 * never appear in real text; TAB/LF/FF/CR/ESC are excluded so text files pass).
 * @param bytes - The leading window to scan.
 * @returns True when at least one binary-data byte is present.
 */
function hasBinaryDataByte(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (
      b <= 0x08 ||
      b === 0x0b ||
      (b >= 0x0e && b <= 0x1a) ||
      (b >= 0x1c && b <= 0x1f)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Sniff a file's authoritative MIME type from its bytes. See the module header
 * for the two-layer rationale.
 * @param bytes - The file's content (or at least its leading bytes).
 * @returns The sniffed MIME type; `application/octet-stream` only for empty or
 *   genuinely-binary input with no recognisable signature.
 */
export async function sniffMimeType(bytes: Uint8Array): Promise<string> {
  if (bytes.length === 0) return "application/octet-stream";

  const detected = await fileTypeFromBuffer(bytes);
  // A concrete binary signature (png / jpeg / mp4 / …) is authoritative. XML is
  // the exception: file-type reports an SVG image and an RSS feed ALIKE as
  // `application/xml`, so it cannot tell them apart — defer both to the
  // content-aware layer, which distinguishes an `<svg` root from other XML.
  if (detected && detected.mime !== "application/xml") return detected.mime;

  // Content-aware layer (SVG / text / binary).
  const head = bytes.subarray(0, SNIFF_WINDOW);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  if (SVG_ROOT.test(text)) return "image/svg+xml";
  // Non-SVG XML (file-type said application/xml) and any signature-less blob
  // with no WHATWG binary-data byte are text → text/plain (`detectAssetKind`
  // → document); everything else is genuinely binary.
  if (detected?.mime === "application/xml" || !hasBinaryDataByte(head)) {
    return "text/plain";
  }
  return "application/octet-stream";
}
