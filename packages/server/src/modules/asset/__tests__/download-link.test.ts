// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Turning an asset's public URL into the address that downloads it.
 *
 * Everything this step decides is decided here, away from HTTP: which URLs
 * name one of our objects, what the ingest Worker is asked for, and which
 * refusals a caller can get.
 */

import { describe, it, expect } from "vitest";
import { AppError } from "@breatic/core";
import { downloadLink } from "@server/modules/asset/download-link.js";

const BASE = "https://assets.example.com";
const INGEST = "https://ingest.example.com";

/** A stand-in that strips `BASE` the way the real adapter does. */
const store = {
  keyFromUrl: (url: string): string | null => {
    const prefix = `${BASE}/`;
    if (!url.startsWith(prefix)) return null;
    const key = url.slice(prefix.length);
    return key === "" ? null : key;
  },
};

/** The status an AppError carries, or null when something else was thrown. */
function statusOf(run: () => unknown): number | null {
  try {
    run();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.statusCode : null;
  }
}

describe("building a download link", () => {
  it("points at the ingest Worker's download route", () => {
    const link = downloadLink(`${BASE}/image/2026-08-13/a.png`, store, INGEST);

    expect(link).toBe(`${INGEST}/download/image/2026-08-13/a.png`);
  });

  it("encodes each key segment", () => {
    // `publicUrl` joins the key on verbatim, so a key holding a space or a
    // non-ASCII name reaches us unescaped and has to be escaped here.
    const link = downloadLink(`${BASE}/image/a b/封面.png`, store, INGEST);

    expect(link).toBe(
      `${INGEST}/download/image/a%20b/${encodeURIComponent("封面.png")}`,
    );
  });

  it("keeps the separators between segments", () => {
    const link = downloadLink(`${BASE}/a/b/c.png`, store, INGEST);

    expect(link).toBe(`${INGEST}/download/a/b/c.png`);
  });

  it("refuses a URL that names nothing of ours", () => {
    expect(statusOf(() => downloadLink("https://evil.test/a.png", store, INGEST))).toBe(400);
  });

  it("refuses a URL that is not a URL", () => {
    expect(statusOf(() => downloadLink("not a url", store, INGEST))).toBe(400);
  });

  it("refuses to build a link when the Worker's address is not configured", () => {
    expect(statusOf(() => downloadLink(`${BASE}/a.png`, store, ""))).toBe(500);
  });
});
