// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { sendInChunks } from '@breatic/shared';

/**
 * The browser WebSocket behind the shared collab connection.
 *
 * collab accepts frames up to `COLLAB_FRAME_MAX_BYTES`; a larger Yjs message
 * (a big paste, an offline catch-up) leaves as a declaration plus chunks that
 * collab reassembles (inner#1585). The provider only sends `Uint8Array`.
 */
export class ChunkingWebSocket extends WebSocket {
  /**
   * Send one message, splitting a `Uint8Array` larger than one collab frame.
   * @param data - What the provider sends.
   */
  override send(data: Parameters<WebSocket['send']>[0]): void {
    if (data instanceof Uint8Array) sendInChunks(data, (frame) => super.send(frame));
    else super.send(data);
  }
}
