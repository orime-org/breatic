// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One upload's bookkeeping, addressed by its storage key (#173, design §4.3).
 *
 * R2 keeps no view of a multipart upload's progress that survives between
 * requests, so "have all the parts arrived?" is answerable only by something
 * that remembers. This is that something: one instance per upload, holding
 * which parts landed and what the ticket said to expect.
 *
 * It also holds the alarm. Every part that arrives pushes it out, so an upload
 * that keeps moving is never cut off however large the file is, and one that
 * stops is judged dead that long after its last part.
 */

/** The Durable Object holding one upload's parts, ticket context and alarm. */
export class UploadSession implements DurableObject {
  readonly #state: DurableObjectState;

  /**
   * @param state - The instance's own storage and alarm.
   */
  constructor(state: DurableObjectState) {
    this.#state = state;
  }

  /**
   * Handle one request from the Worker's fetch handler.
   * @param request - The forwarded request.
   * @returns The response.
   */
  async fetch(request: Request): Promise<Response> {
    void request;
    void this.#state;
    return new Response("Not found", { status: 404 });
  }
}
