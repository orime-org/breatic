// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/** A document the server refused (close 4401/4403, terminal). */
export interface CollabAuthFailure {
  kind: 'auth';
  /** The Yjs document name the refusal was for (e.g. `"project-7/meta"`). */
  docName: string;
  /** WebSocket close code, when the refusal arrived via a close. */
  code?: number;
  /** Server-provided reason string, when available. */
  reason?: string;
}

/**
 * The tab's one collab connection dropped.
 *
 * Every open document rides that connection, so a drop is one event however
 * many documents were attached; the count says how many lost their sync.
 */
export interface CollabDisconnect {
  kind: 'disconnect';
  /** WebSocket close code. */
  code?: number;
  /** Close reason the server sent, when it sent one (e.g. `"Connection Timeout"`). */
  reason?: string;
  /** How many documents were attached to the connection when it dropped. */
  documents: number;
}

/** Structured detail captured at a collab connection failure. */
export type CollabFailureInfo = CollabAuthFailure | CollabDisconnect;

/**
 * Report a collab connection failure to the browser console and Sentry.
 * @param info - Structured failure detail.
 */
export function reportCollabFailure(info: CollabFailureInfo): void {
  const { code, reason } = info;
  const closed =
    (code != null ? ` (close ${code})` : '') + (reason ? `: ${reason}` : '');
  const detail =
    info.kind === 'auth'
      ? `collab auth failure on "${info.docName}"${closed}`
      : `collab disconnect${closed}`;

  // eslint allows console.error/warn (see eslint.config.mts no-console).
  console.error(`[collab] ${detail}`, info);

  Sentry.captureMessage(detail, {
    level: info.kind === 'auth' ? 'error' : 'warning',
    tags: { area: 'collab', kind: info.kind },
    extra: { ...info },
  });
}
