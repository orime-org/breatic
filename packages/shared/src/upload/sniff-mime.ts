// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Backend-authoritative MIME sniffing (#1826, design §4.2) — derives a file's
 * real content type from its BYTES, never from a client claim. Two gates read
 * it: `setAvatar`, which admits an avatar only when the type derived here has
 * an extension in its accepted list, and the ingest Worker, which registers
 * every stored asset under what its bytes read as.
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

import { fileTypeFromBuffer, fileTypeFromStream } from "file-type";

/** SVG root element — an `<svg` followed by whitespace, `/`, or `>`. */
const SVG_ROOT = /<svg[\s/>]/i;

/** How many leading bytes the content-aware fallback inspects. */
export const SNIFF_WINDOW = 1024;

/** What the signature layer answers for markup, which is not a signature. */
const XML = "application/xml";

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
 * What the content-aware layer makes of the leading bytes.
 *
 * Reached only when the signature layer named nothing, or named XML — which
 * `file-type` reports for an SVG image and an RSS feed alike, so it cannot
 * tell them apart and this layer looks for the `<svg` root itself.
 * @param head - The object's leading bytes.
 * @param wasXml - Whether the signature layer said `application/xml`.
 * @returns The type these bytes read as.
 */
function shapeOf(head: Uint8Array, wasXml: boolean): string {
  // Both options spelled out because workerd's TextDecoder types require both,
  // and both are the values the standard already defaults to: bytes that are
  // not valid UTF-8 are replaced rather than thrown over (this window is the
  // head of an arbitrary binary), and a BOM is stripped so the `<svg` search
  // below meets the same text either way.
  const text = new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: false,
  }).decode(head);
  if (SVG_ROOT.test(text)) return "image/svg+xml";
  // Non-SVG XML and any signature-less blob with no WHATWG binary-data byte
  // are text → text/plain (`detectAssetKind` → document); everything else is
  // genuinely binary.
  if (wasXml || !hasBinaryDataByte(head)) {
    return "text/plain";
  }
  return "application/octet-stream";
}

/**
 * What these bytes are, given whatever the signature layer made of them.
 *
 * The two entry points differ only in how they reach the signature layer, and
 * this is everything they decide once it has answered — one gate reads avatars
 * and the other reads every asset that reaches storage, so a rule written twice
 * is a rule the two can stop sharing without anything saying so.
 * @param detected - The signature layer's answer, or undefined for no match.
 * @param head - The leading bytes, for the content-aware layer.
 * @returns The type these bytes read as.
 */
function decide(
  detected: { mime: string } | undefined,
  head: Uint8Array,
): string {
  if (head.length === 0) return "application/octet-stream";
  // A concrete binary signature (png / jpeg / mp4 / …) is authoritative.
  if (detected && detected.mime !== XML) return detected.mime;
  // Cut to the window here rather than inside, so one caller handing over a
  // whole file and another handing over an object's head reach the same bytes.
  return shapeOf(
    head.subarray(0, SNIFF_WINDOW),
    detected?.mime === XML,
  );
}

/**
 * Sniff a file's authoritative MIME type from its bytes. See the module header
 * for the two-layer rationale.
 *
 * For callers holding the whole file. One that holds only a window of a stored
 * object wants {@link sniffMimeTypeOfStream} — a reader handed a window treats
 * it as the entire file, and decides some formats by skipping a header and
 * reading what follows it.
 * @param bytes - The file's content.
 * @returns The sniffed MIME type; `application/octet-stream` only for empty or
 *   genuinely-binary input with no recognisable signature.
 */
export async function sniffMimeType(bytes: Uint8Array): Promise<string> {
  return decide(await fileTypeFromBuffer(bytes), bytes);
}

/**
 * Sniff the type of an object nobody holds the whole of.
 *
 * The signature layer reads the object itself and stops when it knows, so how
 * much it takes is the reader's decision rather than a window somebody picked.
 * Handing it a window instead makes it answer as though that window were the
 * whole file: an MP3 is decided by skipping its ID3 tag and reading the frame
 * sync behind it, and a tag ending just inside the window leaves too few bytes
 * for that read — measured on file-type@22.0.1, an ID3 payload of 4089 or 4090
 * bytes does exactly that to a 4100 byte window, and every window size has its
 * own such values.
 *
 * The content-aware layer keeps working off the leading bytes, which is all an
 * `<svg` root or a run of text needs.
 * @param stream - The object's content, read as far as naming it takes.
 * @param head - Its leading bytes.
 * @returns The sniffed MIME type.
 */
export async function sniffMimeTypeOfStream(
  stream: ReadableStream<Uint8Array>,
  head: Uint8Array,
): Promise<string> {
  return decide(await fileTypeFromStream(stream), head);
}
