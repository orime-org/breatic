// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How the page reader turns a body that is not HTML into text (inner#1664).
 *
 * `recoverUtf8` undoes Chromium's fallback for a text body whose response
 * named no charset: it decodes such a body as windows-1252, so UTF-8 text
 * arrives garbled. `textOfDownload` reads a file Chromium turned into a
 * download as text when its response names a text type.
 */

/** Type families that are media, never text, whatever their suffix (`image/svg+xml`). */
const MEDIA_TYPE = /^(?:image|audio|video)\//;

/**
 * A `content-type` header's media type, lower-cased, without its parameters.
 * @param contentType - The header.
 * @returns The type, or "" when it names none.
 * @throws {never} Never.
 */
export function mediaTypeOf(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Whether a media type is text a page can be read from: `text/*`, XML, JSON,
 * or a type outside the media families that ends in `+xml` or `+json`.
 * @param type - The media type, as `mediaTypeOf` gives it.
 * @returns True for a text type.
 * @throws {never} Never.
 */
export function isTextType(type: string): boolean {
  if (MEDIA_TYPE.test(type)) return false;
  return (
    type.startsWith("text/") ||
    type === "application/xml" ||
    type === "application/json" ||
    type.endsWith("+xml") ||
    type.endsWith("+json")
  );
}

/**
 * The charset a `content-type` header names.
 * @param contentType - The header.
 * @returns The label, or undefined when it names none.
 */
function charsetOf(contentType: string | null): string | undefined {
  return /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1];
}

/** Each character windows-1252 decodes a byte to, mapped back to that byte (WHATWG maps all 256). */
const WINDOWS_1252_BYTE: ReadonlyMap<string, number> = new Map(
  [...new TextDecoder("windows-1252").decode(Uint8Array.from({ length: 256 }, (_, i) => i))].map(
    (char, byte): [string, number] => [char, byte],
  ),
);

/**
 * The text a site sent as UTF-8, when Chromium decoded it as windows-1252
 * because the response named no charset.
 *
 * The text is turned back into its windows-1252 bytes and decoded as strict
 * UTF-8; bytes that are not UTF-8 mean the text really was windows-1252, and
 * it is left alone.
 * @param text - The body as Chromium decoded it.
 * @param contentType - The response's `content-type` header, or null.
 * @param characterSet - The document's `characterSet`, what Chromium decoded it as.
 * @returns The recovered text, or the text unchanged.
 * @throws {never} Never.
 */
export function recoverUtf8(text: string, contentType: string | null, characterSet: string): string {
  if (charsetOf(contentType) !== undefined || characterSet.toLowerCase() !== "windows-1252") return text;
  const bytes: number[] = [];
  for (const char of text) {
    const byte = WINDOWS_1252_BYTE.get(char);
    if (byte === undefined) return text;
    bytes.push(byte);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return text;
  }
}

/**
 * A downloaded file's text, when its response names a text type: decoded in
 * the charset it names, UTF-8 when it names none or one there is no decoder for.
 * @param bytes - The file.
 * @param contentType - The response's `content-type` header, or null.
 * @returns The text, or null when the type is not text.
 * @throws {never} Never.
 */
export function textOfDownload(bytes: Uint8Array, contentType: string | null): string | null {
  if (contentType === null || !isTextType(mediaTypeOf(contentType))) return null;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charsetOf(contentType) ?? "utf-8");
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}
