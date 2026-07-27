// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Default listen ports that BOTH a backend service and the web build config
 * need to know.
 *
 * Why they live in `@breatic/shared` rather than the core env schema: the vite
 * dev server proxies `/api` and `/ws` to the backend, so it has to know where
 * those services listen when `.env` says nothing. `packages/web` may not depend
 * on `@breatic/core` (that is a node/backend package), so before this file the
 * numbers were simply copied into the vite config — and a copy is a thing that
 * drifts (#1831).
 *
 * ADMISSION RULE — read before adding anything here:
 * a port belongs in this file ONLY if the frontend build config also needs it.
 * That is two ports, not six. The three healthz ports (3001 / 9101 / 1235) have
 * exactly one consumer each — the service itself and its docker healthcheck —
 * and `VITE_DEV_PORT` has exactly one consumer too (web). Those stay where
 * their single consumer lives. Moving them here to make the set look tidy would
 * put things in the shared layer that nobody shares, which is precisely what
 * this package's "does web need it?" admission test exists to prevent.
 */

/** API server default listen port (`PORT`). Vite proxies `/api` + `/uploads` here. */
export const DEFAULT_API_PORT = 3000;

/** Collab WebSocket default listen port (`COLLAB_PORT`). Vite proxies `/ws` here. */
export const DEFAULT_COLLAB_PORT = 1234;
