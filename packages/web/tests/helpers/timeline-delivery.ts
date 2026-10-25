// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Buffer } from 'node:buffer';
import type { Page, WebSocketRoute } from 'playwright/test';

/** Original application frames temporarily withheld from one connected browser. */
export interface TimelineDeliveryGate {
  holding: boolean;
  pending: { client: WebSocketRoute; message: Buffer }[];
}

/**
 * Connect to the real server and delay only its binary application frames during the concurrent-edit window.
 * @throws {Error} When Playwright cannot install the route before navigation.
 */
export async function installTimelineDeliveryGate(page: Page): Promise<TimelineDeliveryGate> {
  const gate: TimelineDeliveryGate = { holding: false, pending: [] };
  await page.routeWebSocket('**/*', (client) => {
    const server = client.connectToServer();
    if (client.protocols().includes('vite-hmr')) return;
    // Only the server-side onMessage is overridden: client→server and close forwarding remain real and automatic.
    server.onMessage((message) => {
      if (gate.holding && Buffer.isBuffer(message)) gate.pending.push({ client, message });
      else client.send(message);
    });
  });
  return gate;
}

/**
 * Deliver the exact original frames in their original receive order and resume normal forwarding.
 * @throws {Error} When the real routed socket cannot accept a queued frame.
 */
export function flushTimelineDelivery(gate: TimelineDeliveryGate): void {
  gate.holding = false;
  for (const { client, message } of gate.pending.splice(0)) client.send(message);
}
