// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Standard bearer auth headers.
 * @param apiKey - API key placed in the `Authorization: Bearer` header
 * @returns Headers with bearer auth and a JSON content type
 */
export function bearerHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}
