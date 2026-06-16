// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Collab (Hocuspocus) connection-failure reporting.
 *
 * The browser has no server-side logger, so before this an auth
 * rejection only flipped a status enum and rendered a banner — the
 * close code / reason / doc name were all dropped, leaving production
 * oncall blind to the stuck "session invalid" banner. `console.error`
 * serves local dev; Sentry serves production oncall.
 */

import * as Sentry from '@sentry/react';

/** Whether the collab connection failed on auth (terminal) or a transient disconnect. */
export type CollabFailureKind = 'auth' | 'disconnect';

/** Structured detail captured at a collab connection failure. */
export interface CollabFailureInfo {
  /** `auth` = rejected (close 4401/4403, terminal); `disconnect` = network/server drop. */
  kind: CollabFailureKind;
  /** The Yjs document name the failure occurred on (e.g. `"project-7/meta"`). */
  docName: string;
  /** WebSocket close code, when the failure arrived via `onClose`. */
  code?: number;
  /** Server-provided reason string, when available. */
  reason?: string;
}

/**
 * Report a collab connection failure to the browser console and Sentry.
 * @param info - Structured failure detail (kind, doc name, close code, reason).
 */
export function reportCollabFailure(info: CollabFailureInfo): void {
  const { kind, docName, code, reason } = info;
  const detail =
    `collab ${kind} failure on "${docName}"` +
    (code != null ? ` (close ${code})` : '') +
    (reason ? `: ${reason}` : '');

  // eslint allows console.error/warn (see eslint.config.mts no-console).
  console.error(`[collab] ${detail}`, { kind, docName, code, reason });

  Sentry.captureMessage(detail, {
    level: kind === 'auth' ? 'error' : 'warning',
    tags: { area: 'collab', kind },
    extra: { docName, code, reason },
  });
}
