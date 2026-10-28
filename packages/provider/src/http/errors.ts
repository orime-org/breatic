// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * An address as error messages name it: origin and path, the query and fragment marked as
 * dropped, as shared's redactUrl writes it; they can carry keys and upload sessions.
 * @param url - The address.
 * @returns The address to name.
 */
function named(url: string): string {
  if (!URL.canParse(url)) return "an address that does not parse";
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}${parsed.search !== "" ? "?<redacted>" : ""}${parsed.hash !== "" ? "#<redacted>" : ""}`;
}

/** The request never left this machine: DNS failed or the connection was refused. */
export class NotSent extends Error {
  /**
   * Record what the error carries.
   * @param url - Where it was going.
   * @param cause - The platform error.
   */
  constructor(url: string, cause: unknown) {
    super(`Request to ${named(url)} was not sent`, { cause });
    this.name = "NotSent";
  }
}

/** The request was sent but no complete answer came back: a timeout or a reset. Whether the upstream accepted it is unknown. */
export class NoAnswer extends Error {
  /**
   * Record what the error carries.
   * @param url - Where it went.
   * @param cause - The platform error.
   */
  constructor(url: string, cause: unknown) {
    super(`Request to ${named(url)} got no answer`, { cause });
    this.name = "NoAnswer";
  }
}

/** How much of a failed body a message or log line carries. */
const SNIPPET_CHARS = 500;

/** A response came back with a status the caller treats as a failure. */
export class HttpStatus extends Error {
  readonly status: number;
  /** The whole body, as read; everything that decides from the answer reads it. */
  readonly body: string;
  /** The start of the body, for messages and logs only. */
  readonly bodySnippet: string;
  /** The response headers, when the caller kept them (a Retry-After is read from them). */
  readonly headers?: Headers;

  /**
   * Record what the error carries.
   * @param url - Where it went.
   * @param status - The response status.
   * @param body - The whole body.
   * @param headers - The response headers.
   */
  constructor(url: string, status: number, body: string, headers?: Headers) {
    super(`Request to ${named(url)} answered ${status}`);
    this.name = "HttpStatus";
    this.status = status;
    this.body = body;
    this.bodySnippet = body.slice(0, SNIPPET_CHARS);
    if (headers !== undefined) this.headers = headers;
  }
}

/** The body was larger than the caller allows. */
export class BodyTooLarge extends Error {
  /**
   * Record what the error carries.
   * @param url - Where it came from.
   * @param limit - The allowed bytes.
   */
  constructor(url: string, limit: number) {
    super(`Response from ${named(url)} is larger than ${limit} bytes`);
    this.name = "BodyTooLarge";
  }
}

/** The caller's signal fired or its deadline passed. */
export class Aborted extends Error {
  /**
   * Record what the error carries.
   * @param url - Where it was going.
   */
  constructor(url: string) {
    super(`Request to ${named(url)} was aborted`);
    this.name = "Aborted";
  }
}
