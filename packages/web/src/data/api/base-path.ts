// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Where our backend answers, written once.
 *
 * Two transports reach it — axios for ordinary calls, `fetchEventSource` for
 * the streams — and each used to spell this itself. They drifted: axios said
 * `/api/v1`, the stream wrapper said `/api`, and since the dev proxy forwards
 * `/api/` without rewriting the path, both streaming endpoints were posting
 * to an address the server does not serve. Nothing complained, because
 * neither had a caller yet.
 *
 * The server mounts every route under this prefix (`packages/server/src/app.ts`);
 * nginx does the same in production.
 */
export const API_BASE_PATH = '/api/v1';
