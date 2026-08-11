// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How this service puts an agent chat event on the wire.
 *
 * The names and the envelope are not decided here — they are the shared
 * contract, so the browser reading them and the server writing them work off
 * one declaration. What is decided here is the serialisation: the SSE framing
 * and the camelCase-to-snake_case turn the wire format asks for. Task
 * lifecycle events do not come through here at all; they reach the browser as
 * Yjs document sync via the collab server.
 */
import { SSE_EVENT_NAMES } from "@breatic/shared";
import type { SSEEventName, SSEEventEnvelope } from "@breatic/shared";

/**
 * The shared event names, under the name this service has always called them.
 *
 * Re-exported rather than re-declared: a second list is a second thing to
 * keep in step, and the last time there were two they had nothing in common.
 */
export const SSEEventType = SSE_EVENT_NAMES;

export type SSEEventType = SSEEventName;

/**
 * A single Server-Sent Event, as this service holds it before serialising.
 *
 * `taskId` is camelCase here and `task_id` on the wire; `serializeSSE` is
 * where that turn happens.
 */
export interface SSEEvent {
  event: SSEEventType;
  taskId?: string;
  data: Record<string, unknown>;
}

/**
 * Serialize an SSE event to wire format.
 * @param event - The SSE event to serialize
 * @returns Formatted SSE string: `event: ...\ndata: ...\n\n`
 */
export function serializeSSE(event: SSEEvent): string {
  // Typed as the contract's envelope so the wire shape is checked against the
  // declaration both sides read, rather than being whatever this line builds.
  const envelope: SSEEventEnvelope = {
    event: event.event,
    task_id: event.taskId,
    data: event.data,
  };
  return `event: ${event.event}\ndata: ${JSON.stringify(envelope)}\n\n`;
}
