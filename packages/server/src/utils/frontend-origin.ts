// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env } from "@breatic/core";

/**
 * Select a configured frontend origin for links sent outside the API.
 * Untrusted or absent request origins fall back to the first allowed origin.
 * @param requestOrigin - Origin supplied by the browser, if present.
 * @returns A trusted frontend origin, never the backend request host.
 * @throws {Error} If no valid HTTP frontend origin is configured.
 */
export function frontendOrigin(requestOrigin?: string): string {
  const origins = env.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
    } catch {
      return false;
    }
  });
  const fallback = origins[0];
  if (!fallback) throw new Error("ALLOWED_ORIGINS must include a frontend HTTP origin");
  return requestOrigin && origins.includes(requestOrigin) ? requestOrigin : fallback;
}
