// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading answers from the product API in smoke tests.
 */
import { expect, type APIRequestContext } from 'playwright/test';

/**
 * Read a `{ data }` envelope, failing with the server's words when the call did.
 * @param res - The response.
 * @param label - What the call was, for the failure message.
 * @returns The data.
 */
export async function dataOf<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, label: string): Promise<T> {
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}
