// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a collab message larger than one WebSocket frame travels (inner#1585).
 *
 * collab caps a single frame at {@link COLLAB_FRAME_MAX_BYTES}. A larger
 * binary message goes out on the same socket as a text declaration
 * `{"type":"chunked","bytes":N}` followed by binary chunks of exactly the cap,
 * except that the last one may be shorter, all written in one synchronous
 * call so nothing else can land between them. collab reassembles them into the original bytes and
 * answers the declaration and every chunk but the last with
 * {@link COLLAB_CHUNK_ACK}. Both ends read this module: the cap, the
 * declaration and the acknowledgement are the contract.
 */

import { z } from "zod";

/** The largest single WebSocket frame collab accepts, in bytes. */
export const COLLAB_FRAME_MAX_BYTES = 128 * 1024;

/**
 * What collab sends back for an accepted declaration or chunk. While the
 * chunks fill the browser's uplink, its pongs and awareness renewals wait
 * behind them, so collab's replies to those stop too; with no one else active
 * in its documents, these are then the only messages it receives. The
 * provider counts any message as a sign of life, and this one names no
 * document, so no document provider receives it.
 */
export const COLLAB_CHUNK_ACK = Uint8Array.of(0);

/** The declaration that precedes the chunks of one message. */
export const collabChunkHeaderSchema = z.object({
  type: z.literal("chunked"),
  bytes: z.number().int().gt(COLLAB_FRAME_MAX_BYTES),
});

/**
 * Send one binary message, split into a declaration and chunks when it is
 * larger than one frame.
 * @param bytes - The message.
 * @param send - Writes one frame to the socket.
 */
export function sendInChunks(bytes: Uint8Array, send: (frame: string | Uint8Array) => void): void {
  if (bytes.byteLength <= COLLAB_FRAME_MAX_BYTES) {
    send(bytes);
    return;
  }
  send(JSON.stringify({ type: "chunked", bytes: bytes.byteLength }));
  for (let offset = 0; offset < bytes.byteLength; offset += COLLAB_FRAME_MAX_BYTES) {
    send(bytes.subarray(offset, offset + COLLAB_FRAME_MAX_BYTES));
  }
}
