// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading answers from the product API in smoke tests.
 */
import { expect, type APIResponse } from 'playwright/test';

/** Shared methods of request-context and browser-network API responses. */
type ProductApiResponse = Pick<APIResponse, 'ok' | 'status' | 'text' | 'json'>;

/**
 * Read a `{ data }` envelope, failing with the server's words when the call did.
 * @param res - The response.
 * @param label - What the call was, for the failure message.
 * @returns The data.
 */
export async function dataOf<T>(res: ProductApiResponse, label: string): Promise<T> {
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}
