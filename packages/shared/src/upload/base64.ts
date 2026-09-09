// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Base64 for the credentials our server and the ingest Worker pass between
 * them (#173).
 *
 * Both runtimes have `btoa`, and `btoa` refuses anything outside latin1. What
 * these credentials carry includes a storage key, whose extension comes from
 * the picked file's name — and that name is deliberately allowed to be any
 * Unicode, because the product is a global one. Going through UTF-8 bytes is
 * what makes such a key encodable at all.
 */

/**
 * Base64 a UTF-8 string.
 * @param value - The string to encode.
 * @returns Its base64 form.
 */
export function encodeBase64Utf8(value: string): string {
  return encodeBase64Bytes(new TextEncoder().encode(value));
}

/**
 * Reverse {@link encodeBase64Utf8}.
 * @param value - A base64 string.
 * @returns The decoded UTF-8 string.
 * @throws {Error} When the input is not valid base64.
 */
export function decodeBase64Utf8(value: string): string {
  return new TextDecoder().decode(decodeBase64Bytes(value));
}

/**
 * Base64 raw bytes. The text pair above is written in terms of this one, so
 * a change to how bytes are encoded cannot leave the two disagreeing.
 * @param signature - The raw signature bytes.
 * @returns Its base64 form.
 */
export function encodeBase64Bytes(signature: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(signature)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Reverse {@link encodeBase64Bytes}.
 * @param value - A base64 string.
 * @returns The signature bytes.
 * @throws {Error} When the input is not valid base64.
 */
export function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
