// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transfer file (inner#1006): a request body too large for the API, moved
 * through storage instead. The browser writes it, the ingest Worker recognises
 * it by its first bytes, and the server reads the body back out of it.
 *
 * Layout: the signature line `BREATIC-TRANSFER/1\n` (19 ASCII bytes; `1` is the
 * format version), then the body's `JSON.stringify` output as UTF-8, unchanged.
 * Sizes always count the whole file, signature line included.
 */

/**
 * The storage key directory every transfer file is written under
 * (`transfer/<date>/<name>.transfer`). It is bound to the bucket's lifecycle
 * rule and the public domain's block on the prefix; changing it means
 * changing both.
 */
export const TRANSFER_KEY_DIR = "transfer";

/** The transfer file's media type (an RFC 6838 vendor type). */
export const TRANSFER_MEDIA_TYPE = "application/vnd.breatic.transfer";

/** The whole signature line, version and newline included. */
export const TRANSFER_SIGNATURE = "BREATIC-TRANSFER/1\n";

/** {@link TRANSFER_SIGNATURE} as bytes. */
const SIGNATURE_BYTES = new TextEncoder().encode(TRANSFER_SIGNATURE);

/** Why a transfer file could not be read back. */
export type TransferDecodeReason = "bad_format" | "bad_encoding";

/** A transfer file that does not hold a body. */
export class TransferDecodeError extends Error {
  /**
   * Name why the file holds no body.
   * @param reason - `bad_format` when the signature line is wrong,
   *   `bad_encoding` when what follows it is not valid UTF-8.
   */
  constructor(readonly reason: TransferDecodeReason) {
    super(reason);
    this.name = "TransferDecodeError";
  }
}

/**
 * Do these bytes start with the transfer signature at byte 0?
 * @param bytes - The leading bytes of a file.
 * @returns True when the full signature line is there.
 */
export function startsWithTransferSignature(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE_BYTES.length) return false;
  return SIGNATURE_BYTES.every((b, i) => bytes[i] === b);
}

/**
 * Write a request body as a transfer file.
 * @param json - The body's `JSON.stringify` output.
 * @returns The signature line followed by the JSON's UTF-8 bytes.
 */
export function encodeTransferBody(json: string): Uint8Array<ArrayBuffer> {
  const body = new TextEncoder().encode(json);
  const out = new Uint8Array(SIGNATURE_BYTES.length + body.length);
  out.set(SIGNATURE_BYTES, 0);
  out.set(body, SIGNATURE_BYTES.length);
  return out;
}

/**
 * Read the body back out of a transfer file.
 * @param bytes - The whole file.
 * @returns The text after the signature line.
 * @throws {TransferDecodeError} `bad_format` when the file does not start with
 *   the signature line, `bad_encoding` when the rest is not valid UTF-8.
 */
export function decodeTransferBody(bytes: Uint8Array): string {
  if (!startsWithTransferSignature(bytes)) throw new TransferDecodeError("bad_format");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(SIGNATURE_BYTES.length),
    );
  } catch {
    throw new TransferDecodeError("bad_encoding");
  }
}
