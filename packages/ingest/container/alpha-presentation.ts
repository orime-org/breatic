// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ALPHA_RUN_PATH, type AlphaRunBody, type AlphaRunResult } from '@ingest/alpha-run-contract.js';

/**
 * Execute and verify one platform-funded source preparation in the container.
 * @param job - Fixed source, deadline, limits and private outbound capabilities.
 * @returns Acknowledgement after storage reports and local cleanup.
 * @throws {Error} When the final durable usage report cannot be acknowledged.
 */
export async function runAlphaPresentation(job: AlphaRunBody): Promise<AlphaRunResult> {
  void job;
  throw new Error('Presentation execution awaits its independent RED oracle');
}

/**
 * Reserve the synchronous container route for the already accepted work.
 * @param request - Container-local request.
 * @param response - Original request lifetime.
 * @returns Nothing after the explicit pending response.
 * @throws {never} The RED stub has no background work.
 */
export async function handleAlphaPresentation(request: IncomingMessage, response: ServerResponse): Promise<void> {
  void request;
  response.writeHead(503).end('Presentation implementation pending');
}

export { ALPHA_RUN_PATH };
