// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a stored asset is downloaded from, as an address to navigate to.
 *
 * A string rather than a call: for the file to land in the browser's own
 * download list — with its progress, its pause, its retry — the browser has
 * to make the request itself. Anything we fetch and hand over arrives there
 * as an entry that was already complete.
 */

import { API_BASE_PATH } from '@web/data/api/base-path';

/**
 * The configured backend address that downloads one asset.
 *
 * The server reads the asset URL off the query, confirms the URL is ours,
 * and redirects to the ingest Worker, which serves the object with
 * `Content-Disposition: attachment`.
 * @param assetUrl - The asset's public URL, as a node holds it.
 * @returns The address to navigate to.
 */
export function downloadHref(assetUrl: string): string {
  return `${API_BASE_PATH}/assets/download?url=${encodeURIComponent(assetUrl)}`;
}
