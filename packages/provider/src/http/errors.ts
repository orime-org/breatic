// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The request never left this machine: DNS failed or the connection was refused. */
export class NotSent extends Error {
  /**
   * Record what the error carries.
   * @param url - Where it was going.
   * @param cause - The platform error.
   */
  constructor(url: string, cause: unknown) {
    super(`Request to ${url} was not sent`, { cause });
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
    super(`Request to ${url} got no answer`, { cause });
    this.name = "NoAnswer";
  }
}

/** A response came back with a status the caller treats as a failure. */
export class HttpStatus extends Error {
  readonly status: number;
  readonly bodySnippet: string;
  /** The response headers, when the caller kept them (a Retry-After is read from them). */
  readonly headers?: Headers;
  /** The whole body, when the caller read it whole (an upstream's words can sit past the snippet). */
  readonly body?: string;

  /**
   * Record what the error carries.
   * @param url - Where it went.
   * @param status - The response status.
   * @param bodySnippet - The start of the body, for logs.
   * @param headers - The response headers.
   * @param body - The whole body.
   */
  constructor(url: string, status: number, bodySnippet: string, headers?: Headers, body?: string) {
    super(`Request to ${url} answered ${status}`);
    this.name = "HttpStatus";
    this.status = status;
    this.bodySnippet = bodySnippet;
    if (headers !== undefined) this.headers = headers;
    if (body !== undefined) this.body = body;
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
    super(`Response from ${url} is larger than ${limit} bytes`);
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
    super(`Request to ${url} was aborted`);
    this.name = "Aborted";
  }
}
