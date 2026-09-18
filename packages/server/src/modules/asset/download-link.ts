// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a stored object is downloaded from.
 *
 * The bytes never pass through us: this hands back the ingest Worker's
 * address for one object, and the browser goes and gets it. The Worker is
 * what writes `Content-Disposition`, which is the only way a cross-origin
 * answer reaches the browser's own download list.
 */

import { t } from "@breatic/shared";
import { AppError } from "@breatic/core";

/** What this needs of the bucket: one method, matched structurally. */
interface KeyReader {
  keyFromUrl(url: string): string | null;
}

/**
 * The ingest Worker's download address for the object `assetUrl` names.
 *
 * The caller hands over a whole public URL rather than a key because only
 * this side knows which prefix the bucket is read back from — and the one
 * method that strips it is the one that decides whether the URL is ours at
 * all, so a URL that is not cannot be mistaken for a key.
 * @param assetUrl - The object's public URL, as a node holds it.
 * @param store - The bucket, for reading the key back out of that URL.
 * @param ingestBaseUrl - Where the ingest Worker answers.
 * @returns The address that downloads this object.
 * @throws {AppError} 400 when the URL names no object of ours; 500 when this
 *   deployment has no ingest Worker configured.
 */
export function downloadLink(
  assetUrl: string,
  store: KeyReader,
  ingestBaseUrl: string,
): string {
  const key = store.keyFromUrl(assetUrl);
  if (key === null) {
    throw new AppError(400, t("server.storage.download_not_downloadable"));
  }
  // Checked here rather than at startup: an empty base would otherwise build
  // a relative address, which the browser resolves against our own origin and
  // follows to our own 404 — a wrong answer that names nothing.
  if (ingestBaseUrl === "") {
    throw new AppError(500, t("server.storage.download_unavailable"));
  }
  // Segment by segment, so the separators the key is built from stay
  // separators while everything inside a segment is escaped.
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${ingestBaseUrl}/download/${path}`;
}
